import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AssistantCard, Conversation } from '@/lib/api/types';
import { describeError, isApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { plainText } from './format';
import { describeAssistantError, streamReply, type ReplyEvent } from './stream';

export const MAX_MESSAGE_LENGTH = 2000;
const TITLE_LENGTH = 60;

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: AssistantCard[];
  /** `streaming` until the answer ends; `stopped` by the person; `error` with a reason */
  status: 'done' | 'streaming' | 'stopped' | 'error';
  /** Tools working right now, with the label to show ("Checking your accounts…") */
  tools: Array<{ name: string; label: string }>;
  error?: { title: string; description: string };
  /** For an answer: the question it answers, so it can be asked again */
  prompt?: string;
}

let localIds = 0;
const localId = () => `local-${(localIds += 1)}`;

const titleFor = (text: string) => (text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text);

function failureOf(error: unknown): { title: string; description: string } {
  if (isApiError(error) && error.status !== 0 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 404) {
    const described = describeAssistantError(error.code);
    if (error.status === 429 && error.retryAfterSeconds) {
      return { ...described, description: describeError(error).description };
    }
    return described;
  }
  return describeError(error);
}

/**
 * One conversation with Sphere: sending, streaming the answer into the last turn, stopping, retrying, and
 * switching between stored conversations. `announcement` is what a screen reader should hear next.
 */
export function useSphereChat() {
  const { api, client } = useAuth();
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [loading, setLoading] = useState<{ id: string; error?: unknown } | null>(null);
  const conversationRef = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const draft = useRef('');

  useEffect(() => () => controller.current?.abort(), []);

  const patch = useCallback((id: string, change: (turn: ChatTurn) => Partial<ChatTurn>) => {
    setTurns((all) => all.map((turn) => (turn.id === id ? { ...turn, ...change(turn) } : turn)));
  }, []);

  const apply = useCallback(
    (replyId: string, event: ReplyEvent) => {
      switch (event.type) {
        case 'tool':
          if (event.label) setAnnouncement(event.label);
          patch(replyId, (turn) => ({ tools: [...turn.tools, { name: event.name, label: event.label }] }));
          break;
        case 'result':
          patch(replyId, (turn) => {
            const index = turn.tools.findIndex((tool) => tool.name === event.name);
            return {
              tools: index === -1 ? turn.tools : turn.tools.filter((_, i) => i !== index),
              cards: event.card ? [...turn.cards, event.card] : turn.cards,
            };
          });
          break;
        case 'token':
          draft.current += event.text;
          patch(replyId, (turn) => ({ content: turn.content + event.text }));
          break;
        case 'end':
          patch(replyId, () => ({ status: 'done', tools: [] }));
          setAnnouncement(plainText(draft.current) || 'Sphere answered.');
          break;
        case 'error': {
          const failure = describeAssistantError(event.code);
          patch(replyId, () => ({ status: 'error', tools: [], error: failure }));
          setAnnouncement(failure.title);
          break;
        }
        default:
          break;
      }
    },
    [patch]
  );

  const run = useCallback(
    async (replyId: string, text: string) => {
      const abort = new AbortController();
      controller.current = abort;
      draft.current = '';
      setBusy(true);
      setAnnouncement('Sphere is working on it');
      try {
        let id = conversationRef.current;
        if (!id) {
          const created = await api.assistant.createConversation(titleFor(text));
          id = created.id;
          conversationRef.current = id;
          setConversationId(id);
        }
        const outcome = await streamReply(client, id, text, (event) => apply(replyId, event), abort.signal);
        if (outcome === 'interrupted') {
          patch(replyId, () => ({ status: 'error', tools: [], error: { title: 'The answer was cut off', description: 'The connection dropped. Try again.' } }));
          setAnnouncement('The answer was cut off');
        }
      } catch (error) {
        if (abort.signal.aborted) {
          patch(replyId, () => ({ status: 'stopped', tools: [] }));
          setAnnouncement('Stopped');
        } else {
          const failure = failureOf(error);
          patch(replyId, () => ({ status: 'error', tools: [], error: failure }));
          setAnnouncement(failure.title);
        }
      } finally {
        if (controller.current === abort) controller.current = null;
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: qk.conversations });
      }
    },
    [api, client, apply, patch, queryClient]
  );

  const send = useCallback(
    (content: string) => {
      const text = content.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text || controller.current) return false;
      const reply: ChatTurn = { id: localId(), role: 'assistant', content: '', cards: [], status: 'streaming', tools: [], prompt: text };
      setTurns((all) => [...all, { id: localId(), role: 'user', content: text, cards: [], status: 'done', tools: [] }, reply]);
      void run(reply.id, text);
      return true;
    },
    [run]
  );

  const retry = useCallback(
    (replyId: string) => {
      const turn = turns.find((t) => t.id === replyId);
      if (!turn?.prompt || controller.current) return;
      patch(replyId, () => ({ content: '', cards: [], tools: [], status: 'streaming', error: undefined }));
      void run(replyId, turn.prompt);
    },
    [turns, patch, run]
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(() => {
    controller.current?.abort();
    conversationRef.current = null;
    setConversationId(null);
    setTurns([]);
    setLoading(null);
    setAnnouncement('');
  }, []);

  const open = useCallback(
    async (id: string) => {
      controller.current?.abort();
      setLoading({ id });
      try {
        const conversation = await queryClient.fetchQuery<Conversation>({ queryKey: qk.conversation(id), queryFn: () => api.assistant.conversation(id), staleTime: 0 });
        conversationRef.current = conversation.id;
        setConversationId(conversation.id);
        setTurns(
          conversation.messages.map((message, index, all) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            cards: message.cards,
            status: 'done',
            tools: [],
            prompt: message.role === 'assistant' ? all[index - 1]?.content : undefined,
          }))
        );
        setLoading(null);
        return true;
      } catch (error) {
        setLoading({ id, error });
        return false;
      }
    },
    [api, queryClient]
  );

  const remove = useCallback(
    async (id: string) => {
      await api.assistant.deleteConversation(id);
      queryClient.removeQueries({ queryKey: qk.conversation(id) });
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      if (conversationRef.current === id) reset();
    },
    [api, queryClient, reset]
  );

  return { conversationId, turns, busy, announcement, loading, send, retry, stop, reset, open, remove };
}

export type SphereChat = ReturnType<typeof useSphereChat>;
