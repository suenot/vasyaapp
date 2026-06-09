import { useRef, useState, useMemo } from 'react';
import { useSttStore, WhisperProgress } from '../../store/sttStore';
import { useTauriEvent } from '../../hooks/useTauriEvent';
import { useTranslation, TranslationKey } from '../../i18n';
import './VoiceMessage.css';

interface VoiceMessageProps {
    fileSrc: string;
    filePath: string;
    chatId: number;
    messageId: number;
}

const PROGRESS_KEYS: Record<string, TranslationKey> = {
    loading_model: 'stt_loading_model',
    model_loaded: 'stt_model_loaded',
    converting_audio: 'stt_converting_audio',
    ffmpeg_converting: 'stt_ffmpeg_converting',
    audio_ready: 'stt_audio_ready',
    transcribing: 'stt_transcribing',
    extracting_text: 'stt_extracting_text',
    done: 'stt_done',
};

export const VoiceMessage = ({ fileSrc, filePath, chatId, messageId }: VoiceMessageProps) => {
    const { t } = useTranslation();
    const key = `${chatId}_${messageId}`;

    // Keyed selectors — this voice message only re-renders when *its own*
    // transcription state changes, not when any other message is transcribed.
    const text = useSttStore((s) => s.transcriptions[key]);
    const error = useSttStore((s) => s.errors[key]);
    const isTranscribing = useSttStore((s) => s.transcribing.has(key));
    // Only the message currently being transcribed subscribes to progress.
    const whisperProgress = useSttStore((s) => (s.transcribing.has(key) ? s.whisperProgress : null));
    const transcribe = useSttStore((s) => s.transcribe);
    const clearError = useSttStore((s) => s.clearError);
    const setWhisperProgress = useSttStore((s) => s.setWhisperProgress);

    const audioRef = useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);

    // Register the whisper-progress listener only while this message is being
    // transcribed — avoids one Tauri listener per voice message in the list.
    useTauriEvent<WhisperProgress>('whisper-progress', (payload) => {
        setWhisperProgress(payload);
        if (payload.event === 'done') {
            // Clear progress shortly after done
            setTimeout(() => setWhisperProgress(null), 500);
        }
    }, isTranscribing);

    const formattedTime = useMemo(() => {
        const time = isPlaying || currentTime > 0 ? currentTime : duration;
        const mins = Math.floor(time / 60);
        const secs = Math.floor(time % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }, [currentTime, duration, isPlaying]);

    // Generate fake waveform bars once
    const bars = useMemo(() => {
        return Array.from({ length: 30 }, () => 20 + Math.random() * 60); // height 20-80%
    }, []);

    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
    };

    const handleTranscribe = () => {
        if (text || isTranscribing) return;
        if (error) clearError(key);
        setWhisperProgress(null);
        transcribe(chatId, messageId, filePath);
    };

    const handleTimeUpdate = () => {
        if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime);
        }
    };

    const handleEnded = () => {
        setIsPlaying(false);
        setCurrentTime(0);
    };

    const handleLoadedMetadata = () => {
        if (audioRef.current) {
            setDuration(audioRef.current.duration);
        }
    };

    // Determine active bars based on progress
    const activeBarsCount = duration > 0 ? Math.floor((currentTime / duration) * bars.length) : 0;

    // Progress label for current step
    const progressLabel = isTranscribing && whisperProgress
        ? (PROGRESS_KEYS[whisperProgress.event] ? t(PROGRESS_KEYS[whisperProgress.event]) : t('stt_processing'))
        : null;

    return (
        <div className="voice-message">
            <audio
                ref={audioRef}
                src={fileSrc}
                onTimeUpdate={handleTimeUpdate}
                onEnded={handleEnded}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
            />

            <div className="voice-player">
                <button className="voice-play-button" onClick={togglePlay}>
                    {isPlaying ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="6" y="4" width="4" height="16"></rect>
                            <rect x="14" y="4" width="4" height="16"></rect>
                        </svg>
                    ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                    )}
                </button>

                <div className="voice-waveform-container">
                    <div className="voice-waveform">
                        {bars.map((height, index) => (
                            <div
                                key={index}
                                className={`waveform-bar ${index < activeBarsCount ? 'active' : ''}`}
                                style={{ height: `${height}%` }}
                            />
                        ))}
                    </div>
                    <div className="voice-meta">
                        <span>{formattedTime}</span>
                    </div>
                </div>

                <button
                    className={`voice-stt-button ${text ? 'active' : ''} ${error ? 'error' : ''}`}
                    onClick={handleTranscribe}
                    disabled={isTranscribing}
                    title={error ? `${t('error')}: ${error}` : text ? t('stt_transcribed') : t('stt_transcribe')}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                    </svg>
                </button>
            </div>

            {isTranscribing && (
                <div className="voice-transcription-loading">
                    <div className="loading-dots">
                        <div className="loading-dot"></div>
                        <div className="loading-dot"></div>
                        <div className="loading-dot"></div>
                    </div>
                    <span>{progressLabel || t('stt_transcribing')}</span>
                </div>
            )}

            {error && (
                <div className="voice-transcription-error">
                    {error}
                </div>
            )}

            {text && (
                <div className="voice-transcription-container">
                    <div className="voice-transcription">{text}</div>
                </div>
            )}
        </div>
    );
};
