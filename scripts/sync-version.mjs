// package.json is the product version source; Cargo needs a generated mirror.
import { readFileSync, writeFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid product version');
for (const [path, pattern] of [
  ['../src-tauri/Cargo.toml', /(\[package\]\s*\nname = "telegram-client"\s*\nversion = ")[^"]+(")/],
  ['../src-tauri/Cargo.lock', /(name = "telegram-client"\s*\nversion = ")[^"]+(")/],
]) {
  const url = new URL(path, import.meta.url);
  const original = readFileSync(url, 'utf8');
  const matcher = pattern;
  if (!matcher.test(original)) throw new Error(`Missing application version in ${path}`);
  const updated = original.replace(matcher, (_, before, after) => `${before}${version}${after}`);
  if (original !== updated) {
    if (!process.argv.includes('--write')) throw new Error(`Version drift in ${path}; run npm run version:sync`);
    writeFileSync(url, updated);
  }
}
console.log(`Product version ${version}: manifests synchronized`);
