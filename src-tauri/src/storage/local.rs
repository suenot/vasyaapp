//! Local SQLite storage implementation
//!
//! Implements the DataStorage trait on top of a local SQLite file.

use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::{ChatRecord, DataStorage, FolderRecord, TabRecord};

/// Local SQLite storage
pub struct LocalStorage {
    conn: Arc<Mutex<Connection>>,
}

unsafe impl Send for LocalStorage {}
unsafe impl Sync for LocalStorage {}

impl LocalStorage {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let conn = sqlite::open(path).context("Failed to open database")?;
        let storage = LocalStorage {
            conn: Arc::new(Mutex::new(conn)),
        };
        storage.run_migrations()?;
        Ok(storage)
    }

    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let migration_sql = include_str!("../../migrations/V1__initial_schema.sql");
        conn.execute(migration_sql).context("Failed to run migrations")?;

        // V2: Add account_id to folders and tabs for multi-tenancy
        let _ = conn.execute("ALTER TABLE chat_folders ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");
        let _ = conn.execute("ALTER TABLE chat_tabs ADD COLUMN account_id TEXT NOT NULL DEFAULT ''");

        // Create unique indexes for composite key (id, account_id) — needed for ON CONFLICT
        let _ = conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_folders_id_account ON chat_folders(id, account_id)");
        let _ = conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_tabs_id_account ON chat_tabs(id, account_id)");
        let _ = conn.execute("ALTER TABLE chat_folders ADD COLUMN icon TEXT");

        // V3: Add is_forum flag to chats for Telegram forum/topics support
        let _ = conn.execute("ALTER TABLE chats ADD COLUMN is_forum INTEGER NOT NULL DEFAULT 0");

        Ok(())
    }

    fn now_unix() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }
}

#[async_trait]
impl DataStorage for LocalStorage {
    async fn save_chat(&self, chat: &ChatRecord) -> Result<()> {
        let conn = Arc::clone(&self.conn);
        let chat = chat.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let now = LocalStorage::now_unix();

            let query = "
                INSERT INTO chats (
                    id, account_id, type, title, username, avatar_path,
                    last_message, unread_count, is_forum, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id, account_id) DO UPDATE SET
                    type = excluded.type,
                    title = excluded.title,
                    username = excluded.username,
                    avatar_path = excluded.avatar_path,
                    last_message = excluded.last_message,
                    unread_count = excluded.unread_count,
                    is_forum = excluded.is_forum,
                    updated_at = excluded.updated_at
            ";

            let mut stmt = conn.prepare(query).context("Failed to prepare chat insert")?;
            stmt.bind((1, chat.id)).context("bind chat_id")?;
            stmt.bind((2, chat.account_id.as_str())).context("bind account_id")?;
            stmt.bind((3, chat.chat_type.as_str())).context("bind type")?;
            stmt.bind((4, chat.title.as_str())).context("bind title")?;

            match &chat.username {
                Some(u) => stmt.bind((5, u.as_str())).context("bind username")?,
                None => stmt.bind((5, ())).context("bind username")?,
            };
            match &chat.avatar_path {
                Some(ap) => stmt.bind((6, ap.as_str())).context("bind avatar_path")?,
                None => stmt.bind((6, ())).context("bind avatar_path")?,
            };
            match &chat.last_message {
                Some(lm) => stmt.bind((7, lm.as_str())).context("bind last_message")?,
                None => stmt.bind((7, ())).context("bind last_message")?,
            };

            stmt.bind((8, chat.unread_count as i64)).context("bind unread_count")?;
            stmt.bind((9, if chat.is_forum { 1i64 } else { 0i64 })).context("bind is_forum")?;
            stmt.bind((10, now)).context("bind created_at")?;
            stmt.bind((11, now)).context("bind updated_at")?;
            stmt.next().context("execute chat insert")?;

            Ok(())
        })
        .await
        .context("spawn_blocking panicked")?
    }

    async fn get_chats(&self, account_id: &str) -> Result<Vec<ChatRecord>> {
        let conn = Arc::clone(&self.conn);
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let query = "
                SELECT id, account_id, type, title, username, avatar_path,
                       last_message, unread_count, is_forum, updated_at
                FROM chats
                WHERE account_id = ?
                ORDER BY updated_at DESC
            ";

            let mut stmt = conn.prepare(query).context("Failed to prepare chats query")?;
            stmt.bind((1, account_id.as_str())).context("bind account_id")?;

            let mut chats = Vec::new();
            while let Ok(sqlite::State::Row) = stmt.next() {
                chats.push(ChatRecord {
                    id: stmt.read::<i64, _>("id").unwrap(),
                    account_id: stmt.read::<String, _>("account_id").unwrap(),
                    chat_type: stmt.read::<String, _>("type").unwrap(),
                    title: stmt.read::<String, _>("title").unwrap(),
                    username: stmt.read::<Option<String>, _>("username").unwrap(),
                    avatar_path: stmt.read::<Option<String>, _>("avatar_path").unwrap(),
                    last_message: stmt.read::<Option<String>, _>("last_message").unwrap(),
                    unread_count: stmt.read::<i64, _>("unread_count").unwrap() as i32,
                    is_forum: stmt.read::<i64, _>("is_forum").unwrap_or(0) != 0,
                });
            }

            Ok(chats)
        })
        .await
        .context("spawn_blocking panicked")?
    }

    async fn get_folders(&self, account_id: &str) -> Result<Vec<FolderRecord>> {
        let conn = Arc::clone(&self.conn);
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, name, icon, included_chat_types, excluded_chat_types, \
                 included_chat_ids, excluded_chat_ids, sort_order \
                 FROM chat_folders WHERE account_id = ? ORDER BY sort_order"
            ).context("prepare")?;
            stmt.bind((1, account_id.as_str())).unwrap();

            let mut result = Vec::new();
            while let Ok(sqlite::State::Row) = stmt.next() {
                result.push(FolderRecord {
                    id: stmt.read::<String, _>("id").unwrap(),
                    account_id: account_id.clone(),
                    name: stmt.read::<String, _>("name").unwrap(),
                    icon: stmt.read::<Option<String>, _>("icon").unwrap(),
                    included_chat_types: serde_json::from_str(
                        &stmt.read::<String, _>("included_chat_types").unwrap(),
                    ).unwrap_or_default(),
                    excluded_chat_types: serde_json::from_str(
                        &stmt.read::<String, _>("excluded_chat_types").unwrap(),
                    ).unwrap_or_default(),
                    included_chat_ids: serde_json::from_str(
                        &stmt.read::<String, _>("included_chat_ids").unwrap(),
                    ).unwrap_or_default(),
                    excluded_chat_ids: serde_json::from_str(
                        &stmt.read::<String, _>("excluded_chat_ids").unwrap(),
                    ).unwrap_or_default(),
                    sort_order: stmt.read::<i64, _>("sort_order").unwrap() as i32,
                });
            }
            Ok(result)
        })
        .await
        .context("spawn_blocking")?
    }

    async fn save_folder(&self, account_id: &str, folder: &FolderRecord) -> Result<()> {
        let conn = Arc::clone(&self.conn);
        let folder = folder.clone();
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let now = LocalStorage::now_unix();
            let mut stmt = conn.prepare(
                "INSERT INTO chat_folders (id, account_id, name, icon, included_chat_types, excluded_chat_types, \
                 included_chat_ids, excluded_chat_ids, sort_order, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id, account_id) DO UPDATE SET \
                 name=excluded.name, icon=excluded.icon, included_chat_types=excluded.included_chat_types, \
                 excluded_chat_types=excluded.excluded_chat_types, \
                 included_chat_ids=excluded.included_chat_ids, \
                 excluded_chat_ids=excluded.excluded_chat_ids, \
                 sort_order=excluded.sort_order, updated_at=excluded.updated_at"
            ).context("prepare")?;

            stmt.bind((1, folder.id.as_str())).unwrap();
            stmt.bind((2, account_id.as_str())).unwrap();
            stmt.bind((3, folder.name.as_str())).unwrap();
            match &folder.icon {
                Some(icon) => stmt.bind((4, icon.as_str())).unwrap(),
                None => stmt.bind((4, ())).unwrap(),
            }
            stmt.bind((5, serde_json::to_string(&folder.included_chat_types).unwrap().as_str())).unwrap();
            stmt.bind((6, serde_json::to_string(&folder.excluded_chat_types).unwrap().as_str())).unwrap();
            stmt.bind((7, serde_json::to_string(&folder.included_chat_ids).unwrap().as_str())).unwrap();
            stmt.bind((8, serde_json::to_string(&folder.excluded_chat_ids).unwrap().as_str())).unwrap();
            stmt.bind((9, folder.sort_order as i64)).unwrap();
            stmt.bind((10, now)).unwrap();
            stmt.bind((11, now)).unwrap();
            stmt.next().context("execute")?;
            Ok(())
        })
        .await
        .context("spawn_blocking")?
    }

    async fn delete_folder(&self, account_id: &str, id: &str) -> Result<()> {
        let conn = Arc::clone(&self.conn);
        let id = id.to_string();
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare("DELETE FROM chat_folders WHERE id = ? AND account_id = ?").context("prepare")?;
            stmt.bind((1, id.as_str())).unwrap();
            stmt.bind((2, account_id.as_str())).unwrap();
            stmt.next().context("execute")?;
            let mut stmt2 = conn.prepare("DELETE FROM chat_tabs WHERE id = ? AND account_id = ?").context("prepare")?;
            stmt2.bind((1, id.as_str())).unwrap();
            stmt2.bind((2, account_id.as_str())).unwrap();
            stmt2.next().context("execute")?;
            Ok(())
        })
        .await
        .context("spawn_blocking")?
    }

    async fn get_tabs(&self, account_id: &str) -> Result<Vec<TabRecord>> {
        let conn = Arc::clone(&self.conn);
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT id, visible, sort_order FROM chat_tabs WHERE account_id = ? ORDER BY sort_order"
            ).context("prepare")?;
            stmt.bind((1, account_id.as_str())).unwrap();

            let mut result = Vec::new();
            while let Ok(sqlite::State::Row) = stmt.next() {
                result.push(TabRecord {
                    id: stmt.read::<String, _>("id").unwrap(),
                    account_id: account_id.clone(),
                    visible: stmt.read::<i64, _>("visible").unwrap() != 0,
                    sort_order: stmt.read::<i64, _>("sort_order").unwrap() as i32,
                });
            }
            Ok(result)
        })
        .await
        .context("spawn_blocking")?
    }

    async fn save_tabs(&self, account_id: &str, tabs: &[TabRecord]) -> Result<()> {
        let conn = Arc::clone(&self.conn);
        let tabs = tabs.to_vec();
        let account_id = account_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut del_stmt = conn.prepare("DELETE FROM chat_tabs WHERE account_id = ?").context("clear")?;
            del_stmt.bind((1, account_id.as_str())).unwrap();
            del_stmt.next().context("execute delete")?;
            for tab in &tabs {
                let mut stmt = conn.prepare(
                    "INSERT INTO chat_tabs (id, account_id, visible, sort_order) VALUES (?, ?, ?, ?)"
                ).context("prepare")?;
                stmt.bind((1, tab.id.as_str())).unwrap();
                stmt.bind((2, account_id.as_str())).unwrap();
                stmt.bind((3, if tab.visible { 1i64 } else { 0i64 })).unwrap();
                stmt.bind((4, tab.sort_order as i64)).unwrap();
                stmt.next().context("execute")?;
            }
            Ok(())
        })
        .await
        .context("spawn_blocking")?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_storage(dir: &std::path::Path) -> LocalStorage {
        let db_path = dir.join("test.db");
        LocalStorage::open(&db_path).expect("Failed to open test database")
    }

    fn sample_chat(id: i64, account_id: &str) -> ChatRecord {
        ChatRecord {
            id,
            account_id: account_id.to_string(),
            chat_type: "group".to_string(),
            title: format!("Chat {}", id),
            username: Some(format!("chat{}", id)),
            avatar_path: None,
            last_message: Some("hello".to_string()),
            unread_count: 1,
            is_forum: false,
        }
    }

    fn sample_folder(id: &str, sort_order: i32) -> FolderRecord {
        FolderRecord {
            id: id.to_string(),
            account_id: String::new(),
            name: format!("Folder {}", id),
            icon: Some("folder".to_string()),
            included_chat_types: vec!["group".to_string()],
            excluded_chat_types: vec![],
            included_chat_ids: vec![100],
            excluded_chat_ids: vec![],
            sort_order,
        }
    }

    fn sample_tab(id: &str, visible: bool, sort_order: i32) -> TabRecord {
        TabRecord {
            id: id.to_string(),
            account_id: String::new(),
            visible,
            sort_order,
        }
    }

    #[test]
    fn db_file_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        assert!(!db_path.exists());
        let _storage = LocalStorage::open(&db_path).unwrap();
        assert!(db_path.exists());
    }

    #[tokio::test]
    async fn save_and_get_chats() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        let chat = sample_chat(1, "account-a");
        storage.save_chat(&chat).await.unwrap();

        let chats = storage.get_chats("account-a").await.unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].id, 1);
        assert_eq!(chats[0].title, "Chat 1");
        assert_eq!(chats[0].chat_type, "group");
        assert_eq!(chats[0].username, Some("chat1".to_string()));
        assert_eq!(chats[0].unread_count, 1);
    }

    #[tokio::test]
    async fn save_chat_upserts() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        let mut chat = sample_chat(1, "acc");
        storage.save_chat(&chat).await.unwrap();

        chat.title = "Updated Title".to_string();
        chat.unread_count = 99;
        storage.save_chat(&chat).await.unwrap();

        let chats = storage.get_chats("acc").await.unwrap();
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0].title, "Updated Title");
        assert_eq!(chats[0].unread_count, 99);
    }

    #[tokio::test]
    async fn save_and_get_folders() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        let folder = sample_folder("f1", 0);
        storage.save_folder("acc", &folder).await.unwrap();

        let folders = storage.get_folders("acc").await.unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, "f1");
        assert_eq!(folders[0].name, "Folder f1");
        assert_eq!(folders[0].included_chat_types, vec!["group"]);
        assert_eq!(folders[0].included_chat_ids, vec![100]);
        assert_eq!(folders[0].sort_order, 0);
    }

    #[tokio::test]
    async fn folders_ordered_by_sort_order() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        storage.save_folder("acc", &sample_folder("f2", 2)).await.unwrap();
        storage.save_folder("acc", &sample_folder("f1", 1)).await.unwrap();
        storage.save_folder("acc", &sample_folder("f3", 3)).await.unwrap();

        let folders = storage.get_folders("acc").await.unwrap();
        assert_eq!(folders.len(), 3);
        assert_eq!(folders[0].id, "f1");
        assert_eq!(folders[1].id, "f2");
        assert_eq!(folders[2].id, "f3");
    }

    #[tokio::test]
    async fn delete_folder() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        storage.save_folder("acc", &sample_folder("f1", 0)).await.unwrap();
        storage.save_folder("acc", &sample_folder("f2", 1)).await.unwrap();

        storage.delete_folder("acc", "f1").await.unwrap();

        let folders = storage.get_folders("acc").await.unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, "f2");
    }

    #[tokio::test]
    async fn delete_nonexistent_folder_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());
        // Should not error when deleting a folder that does not exist
        storage.delete_folder("acc", "no-such-folder").await.unwrap();
    }

    #[tokio::test]
    async fn save_and_get_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        let tabs = vec![
            sample_tab("all", true, 0),
            sample_tab("contacts", false, 1),
            sample_tab("custom", true, 2),
        ];
        storage.save_tabs("acc", &tabs).await.unwrap();

        let result = storage.get_tabs("acc").await.unwrap();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].id, "all");
        assert!(result[0].visible);
        assert_eq!(result[1].id, "contacts");
        assert!(!result[1].visible);
        assert_eq!(result[2].id, "custom");
        assert!(result[2].visible);
    }

    #[tokio::test]
    async fn save_tabs_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        let tabs1 = vec![sample_tab("a", true, 0), sample_tab("b", true, 1)];
        storage.save_tabs("acc", &tabs1).await.unwrap();

        let tabs2 = vec![sample_tab("c", false, 0)];
        storage.save_tabs("acc", &tabs2).await.unwrap();

        let result = storage.get_tabs("acc").await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "c");
    }

    #[tokio::test]
    async fn accounts_are_isolated_chats() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        storage.save_chat(&sample_chat(1, "alice")).await.unwrap();
        storage.save_chat(&sample_chat(2, "alice")).await.unwrap();
        storage.save_chat(&sample_chat(3, "bob")).await.unwrap();

        let alice_chats = storage.get_chats("alice").await.unwrap();
        let bob_chats = storage.get_chats("bob").await.unwrap();
        let empty = storage.get_chats("nobody").await.unwrap();

        assert_eq!(alice_chats.len(), 2);
        assert_eq!(bob_chats.len(), 1);
        assert_eq!(bob_chats[0].id, 3);
        assert!(empty.is_empty());
    }

    #[tokio::test]
    async fn accounts_are_isolated_folders() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        storage.save_folder("alice", &sample_folder("f1", 0)).await.unwrap();
        storage.save_folder("bob", &sample_folder("f2", 0)).await.unwrap();

        let alice = storage.get_folders("alice").await.unwrap();
        let bob = storage.get_folders("bob").await.unwrap();
        let empty = storage.get_folders("nobody").await.unwrap();

        assert_eq!(alice.len(), 1);
        assert_eq!(alice[0].id, "f1");
        assert_eq!(bob.len(), 1);
        assert_eq!(bob[0].id, "f2");
        assert!(empty.is_empty());
    }

    #[tokio::test]
    async fn accounts_are_isolated_tabs() {
        let dir = tempfile::tempdir().unwrap();
        let storage = make_test_storage(dir.path());

        storage.save_tabs("alice", &[sample_tab("t1", true, 0)]).await.unwrap();
        storage.save_tabs("bob", &[sample_tab("t2", false, 0)]).await.unwrap();

        let alice = storage.get_tabs("alice").await.unwrap();
        let bob = storage.get_tabs("bob").await.unwrap();
        let empty = storage.get_tabs("nobody").await.unwrap();

        assert_eq!(alice.len(), 1);
        assert_eq!(alice[0].id, "t1");
        assert_eq!(bob.len(), 1);
        assert_eq!(bob[0].id, "t2");
        assert!(empty.is_empty());
    }
}
