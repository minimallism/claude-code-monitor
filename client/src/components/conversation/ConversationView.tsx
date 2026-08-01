import { useEffect, useState, useCallback, useRef } from "react";
import { ChevronDown, Loader2, ArrowDown } from "lucide-react";
import { api } from "../../lib/api";
import { eventBus } from "../../lib/eventBus";
import { MessageList } from "./MessageList";
import type { TranscriptMessage, TranscriptInfo, WSMessage } from "../../lib/types";

const POLL_INTERVAL_MS = 3000;

const TRANSCRIPTS_REFRESH_MS = 15000;

interface ConversationViewProps {
  sessionId: string;
  initialTranscriptId?: string | null;
  onTotalChange?: (total: number) => void;
}

export function ConversationView({ sessionId, initialTranscriptId, onTotalChange }: ConversationViewProps) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const [loading, setLoading] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [selectedTranscript, setSelectedTranscript] = useState<string | null>(
    initialTranscriptId ?? null
  );
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptInfo[]>([]);
  const [showNewMsg, setShowNewMsg] = useState(false);

  
  const lastLineRef = useRef(0);
  const firstLineRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const fetchingRef = useRef(false);
  
  
  
  const pendingFetchRef = useRef(false);
  
  
  
  
  useEffect(() => {
    let cancelled = false;
    async function loadTranscripts() {
      try {
        const result = await api.sessions.transcripts(sessionId);
        if (cancelled) return;
        setTranscripts(result.transcripts);
      } catch {
        
      }
    }
    loadTranscripts();
    const interval = window.setInterval(loadTranscripts, TRANSCRIPTS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  
  useEffect(() => {
    if (initialTranscriptId != null) {
      setSelectedTranscript(initialTranscriptId);
    }
  }, [initialTranscriptId]);

  
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setError(null);
        setLoading(true);
        setShowNewMsg(false);
        const result = await api.sessions.transcript(sessionId, {
          agent_id: selectedTranscript || undefined,
          limit: 50,
        });
        if (cancelled) return;
        setMessages(result.messages);
        setTotal(result.total);
        setHasMore(result.has_more);
        lastLineRef.current = result.last_line;
        firstLineRef.current = result.first_line;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load transcript");
        setMessages([]);
        setTotal(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedTranscript]);

  
  
  
  
  
  
  
  const fetchNewMessages = useCallback(async () => {
    if (fetchingRef.current) {
      
      
      pendingFetchRef.current = true;
      return;
    }
    fetchingRef.current = true;
    pendingFetchRef.current = false;

    const wasBootstrap = lastLineRef.current === 0;
    try {
      const result = await api.sessions.transcript(sessionId, {
        agent_id: selectedTranscript || undefined,
        ...(wasBootstrap ? {} : { after: lastLineRef.current }),
        limit: 50,
      });
      if (result.messages.length === 0) return;

      lastLineRef.current = result.last_line;

      if (wasBootstrap) {
        
        
        setMessages(result.messages);
        firstLineRef.current = result.first_line;
        setHasMore(result.has_more);
      } else {
        setMessages((prev) => [...prev, ...result.messages]);
      }
      setTotal(result.total);

      
      if (isAtBottomRef.current) {
        scrollToBottom();
      } else {
        setShowNewMsg(true);
      }
    } catch {
      
    } finally {
      fetchingRef.current = false;
      
      if (pendingFetchRef.current) {
        pendingFetchRef.current = false;
        
        setTimeout(() => fetchNewMessages(), 0);
      }
    }
    
  }, [sessionId, selectedTranscript]);

  
  
  
  useEffect(() => {
    const unsubscribe = eventBus.subscribe((msg: WSMessage) => {
      if (msg.type !== "new_event") return;
      const data = msg.data as { session_id?: string };
      if (data.session_id !== sessionId) return;
      fetchNewMessages();
    });
    return unsubscribe;
  }, [sessionId, fetchNewMessages]);

  
  
  
  useEffect(() => {
    return eventBus.onConnection((connected) => {
      if (connected) fetchNewMessages();
    });
  }, [fetchNewMessages]);

  
  
  
  
  
  useEffect(() => {
    let interval: number | null = null;
    function start() {
      if (interval !== null) return;
      interval = window.setInterval(() => {
        if (document.visibilityState === "visible") fetchNewMessages();
      }, POLL_INTERVAL_MS);
    }
    function stop() {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    }
    function onVisibility() {
      if (document.visibilityState === "visible") {
        
        
        
        fetchNewMessages();
        start();
      } else {
        stop();
      }
    }
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchNewMessages]);

  
  
  
  const loadHistory = useCallback(async () => {
    if (loadingHistory || !hasMore) return;
    
    
    
    try {
      setLoadingHistory(true);
      const container = scrollContainerRef.current;
      const prevScrollHeight = container?.scrollHeight ?? 0;

      const result = await api.sessions.transcript(sessionId, {
        agent_id: selectedTranscript || undefined,
        before: firstLineRef.current || undefined,
        limit: 50,
      });

      if (result.messages.length === 0) {
        
        
        setHasMore(false);
        setLoadingHistory(false);
        return;
      }

      
      firstLineRef.current = result.first_line;

      setMessages((prev) => [...result.messages, ...prev]);
      setHasMore(result.has_more);

      
      requestAnimationFrame(() => {
        if (container) {
          const newScrollHeight = container.scrollHeight;
          container.scrollTop = newScrollHeight - prevScrollHeight;
        }
      });
    } catch {
      
    } finally {
      setLoadingHistory(false);
    }
  }, [sessionId, selectedTranscript, loadingHistory, hasMore]);

  
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }, []);

  
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    isAtBottomRef.current = atBottom;

    
    if (atBottom) {
      setShowNewMsg(false);
    }

    
    if (container.scrollTop < 50 && hasMore && !loadingHistory) {
      loadHistory();
    }
  }, [hasMore, loadingHistory, loadHistory]);

  
  useEffect(() => {
    if (!loading && messages.length > 0) {
      scrollToBottom();
    }
  }, [loading, scrollToBottom]); 

  return (
    <div className="relative flex flex-col" style={{ minHeight: 0 }}>
      {
}
      {!loading && (
        <div className="flex items-center gap-3 mb-3 flex-shrink-0">
          {transcripts.length > 1 && (
            <div className="relative">
              <select
                value={selectedTranscript || ""}
                onChange={(e) => setSelectedTranscript(e.target.value || null)}
                className="appearance-none bg-surface-2 border border-surface-3 rounded-lg px-3 py-1.5 pr-8 text-sm text-slate-300 focus:outline-none focus:border-accent/50 hover:border-accent/30 cursor-pointer transition-colors"
              >
                {transcripts.map((transcript) => (
                  <option key={transcript.id} value={transcript.id}>
                    {transcript.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm text-status-error bg-status-error/10 border border-status-error/20 rounded-lg px-4 py-3 flex-shrink-0">
          {error}
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        style={{ maxHeight: "calc(100vh - 320px)", minHeight: 200 }}
      >
        {loadingHistory && (
          <div className="flex justify-center py-3">
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin" />
            <span className="text-xs text-slate-500 ml-2">Loading history...</span>
          </div>
        )}

        {hasMore && !loadingHistory && !loading && (
          <div className="flex justify-center py-2">
            <span className="text-[11px] text-slate-600">↑ Scroll up for older messages</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-500 text-sm">
            Loading conversation...
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-md py-12 text-center">
            <p className="text-sm text-slate-400">No conversation records found.</p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              This session's metadata was imported, but its transcript file is no longer on disk.
              Claude Code automatically deletes inactive session transcripts after a retention
              period (<code className="text-slate-400">cleanupPeriodDays</code>, default 30 days), so
              older conversations may already be gone.
            </p>
          </div>
        ) : (
          <MessageList messages={messages} loading={false} />
        )}
      </div>

      {showNewMsg && (
        <button
          onClick={() => {
            scrollToBottom();
            setShowNewMsg(false);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-accent-dim hover:bg-accent text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg transition-colors z-10"
        >
          <ArrowDown className="w-3 h-3" />
          New messages
        </button>
      )}
    </div>
  );
}
