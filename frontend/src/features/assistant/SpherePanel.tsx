import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowUp, ChevronLeft, History, Loader2, MessagesSquare, RotateCw, Square, SquarePen, Trash2, X } from 'lucide-react';
import type { ConversationSummary } from '@/lib/api/types';
import { useAuth, useUser } from '@/lib/auth/AuthProvider';
import { qk } from '@/lib/query';
import { notifyError } from '@/lib/notify';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/data';
import { Callout, EmptyState, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { AnswerCard } from './Cards';
import { FormattedText } from './format';
import { MAX_MESSAGE_LENGTH, useSphereChat, type ChatTurn, type SphereChat } from './useSphereChat';

export const SPHERE_DISCLAIMER = "Sphere can't move money. Answers can be wrong; check important details.";

const iconButton =
  'relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9 [&_svg]:size-[18px]';

const updatedFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/**
 * Sphere, the assistant. A side panel on larger screens and a full-height bottom sheet on phones; it stays
 * mounted once opened, so a conversation (even one still streaming) survives closing and reopening it.
 */
export default function SpherePanel({ open, onOpenChange, onClosed }: { open: boolean; onOpenChange: (open: boolean) => void; onClosed?: () => void }) {
  const { api } = useAuth();
  const user = useUser();
  const navigate = useNavigate();
  const chat = useSphereChat();
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const customer = user.role === 'CUSTOMER';

  const meta = useQuery({ queryKey: qk.assistantMeta, queryFn: () => api.assistant.meta(), enabled: open, staleTime: 5 * 60_000 });

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };
  const focusComposer = () => requestAnimationFrame(() => composer.current?.focus());

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 duration-300 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:bg-black/15" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(event) => {
            // Chat opens on the composer; the conversation list keeps Radix's default (its first control)
            if (view !== 'chat') return;
            event.preventDefault();
            composer.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // There is no Dialog.Trigger: hand focus back to whichever launcher opened Sphere
            event.preventDefault();
            onClosed?.();
          }}
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground shadow-elevated outline-none dark:ring-1 dark:ring-white/[0.08]',
            // Phones: a full-height sheet from the bottom edge. Larger screens: a panel on the right.
            'inset-x-0 bottom-0 top-[max(env(safe-area-inset-top),0.75rem)] rounded-t-[28px]',
            'sm:inset-x-auto sm:bottom-3 sm:right-3 sm:top-3 sm:w-[420px] sm:max-w-[calc(100vw-1.5rem)] sm:rounded-[24px]',
            'duration-300 ease-spring data-[state=closed]:animate-out data-[state=open]:animate-in',
            'max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:slide-in-from-bottom sm:data-[state=closed]:slide-out-to-right sm:data-[state=open]:slide-in-from-right'
          )}
        >
          <span aria-hidden="true" className="absolute left-1/2 top-2 h-[5px] w-9 -translate-x-1/2 rounded-full bg-foreground/15 sm:hidden" />
          <header className="flex h-[60px] shrink-0 items-center gap-1 border-b border-border/70 px-2 pt-2 sm:h-14 sm:pt-0">
            {view === 'history' ? (
              <button type="button" className={iconButton} aria-label="Back to chat" onClick={() => setView('chat')}>
                <ChevronLeft aria-hidden="true" />
              </button>
            ) : (
              <button type="button" className={iconButton} aria-label="Conversations" onClick={() => setView('history')}>
                <History aria-hidden="true" />
              </button>
            )}
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate px-1 text-headline">{view === 'history' ? 'Conversations' : 'Sphere'}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              {customer ? 'Ask about your accounts, payments and spending, or how BankSphere works.' : 'Ask how BankSphere works and where to find things.'}
            </DialogPrimitive.Description>
            <button
              type="button"
              className={iconButton}
              aria-label="New conversation"
              onClick={() => {
                chat.reset();
                setView('chat');
                focusComposer();
              }}
            >
              <SquarePen aria-hidden="true" />
            </button>
            <DialogPrimitive.Close className={iconButton} aria-label="Close Sphere">
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>

          {view === 'history' ? (
            <HistoryView
              enabled={open}
              currentId={chat.conversationId}
              onOpen={(id) => {
                setView('chat');
                void chat.open(id);
              }}
              onDelete={setDeleting}
            />
          ) : (
            <>
              <ChatView chat={chat} customer={customer} suggestions={meta.data?.suggestions ?? []} onNavigate={customer ? go : undefined} />
              <Composer chat={chat} inputRef={composer} />
            </>
          )}

          <div className="sr-only" aria-live="polite" aria-atomic="true">
            {chat.announcement}
          </div>

          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(next) => !next && setDeleting(null)}
            tone="destructive"
            title="Delete this conversation?"
            description="It will be removed from your history. This can’t be undone."
            confirmLabel="Delete conversation"
            onConfirm={async () => {
              if (!deleting) return;
              try {
                await chat.remove(deleting.id);
              } catch (error) {
                notifyError(error);
                throw error;
              }
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ChatView({
  chat,
  customer,
  suggestions,
  onNavigate,
}: {
  chat: SphereChat;
  customer: boolean;
  suggestions: string[];
  onNavigate?: (to: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = chat.turns[chat.turns.length - 1];

  // Follow the answer as it grows, unless the person has scrolled up to read something
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || last?.role === 'user' || last?.content === '') el.scrollTop = el.scrollHeight;
  }, [chat.turns, last]);

  let body;
  if (chat.loading && !chat.loading.error) {
    body = (
      <div className="flex flex-1 items-center justify-center" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Opening the conversation</span>
      </div>
    );
  } else if (chat.loading?.error) {
    const id = chat.loading.id;
    body = <ErrorState error={chat.loading.error} onRetry={() => void chat.open(id)} />;
  } else if (chat.turns.length === 0) {
    body = (
      <div className="flex flex-1 flex-col justify-end gap-5 pb-2">
        <EmptyState
          icon={MessagesSquare}
          title="Ask Sphere"
          description={
            customer
              ? 'Questions about your balances, payments and spending, or how something works in BankSphere.'
              : 'Questions about how BankSphere works and where to find things.'
          }
          className="py-6"
        />
        {suggestions.length ? (
          <div role="group" aria-label="Suggestions" className="flex flex-col items-stretch gap-2">
            {suggestions.slice(0, 4).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => chat.send(suggestion)}
                className="min-h-11 cursor-pointer rounded-2xl bg-card px-4 py-2.5 text-left text-[14px] leading-5 shadow-card transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  } else {
    body = (
      <ol aria-label="Conversation" className="space-y-6">
        {chat.turns.map((turn) => (
          <li key={turn.id}>
            {turn.role === 'user' ? (
              <UserBubble turn={turn} />
            ) : (
              <Answer turn={turn} busy={chat.busy} onRetry={() => chat.retry(turn.id)} onNavigate={onNavigate} />
            )}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-canvas px-4 py-5">
      {body}
    </div>
  );
}

function UserBubble({ turn }: { turn: ChatTurn }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-[20px] rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-[22px] [overflow-wrap:anywhere]">
        <span className="sr-only">You: </span>
        {turn.content}
      </p>
    </div>
  );
}

function Answer({ turn, busy, onRetry, onNavigate }: { turn: ChatTurn; busy: boolean; onRetry: () => void; onNavigate?: (to: string) => void }) {
  const thinking = turn.status === 'streaming' && !turn.content && turn.tools.length === 0 && turn.cards.length === 0;
  return (
    <div className="space-y-3">
      <span className="sr-only">Sphere: </span>
      {turn.tools.map((tool, index) => (
        <p key={`${tool.name}-${index}`} className="flex items-center gap-2 text-[14px] text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          {tool.label || 'Looking that up…'}
        </p>
      ))}
      {thinking ? (
        <p className="flex items-center gap-2 text-[14px] text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          Thinking…
        </p>
      ) : null}
      {turn.cards.map((card, index) => (
        <AnswerCard key={`${card.type}-${index}`} card={card} onNavigate={onNavigate} />
      ))}
      {turn.content ? <FormattedText text={turn.content} /> : null}
      {turn.status === 'stopped' ? (
        <p className="flex flex-wrap items-center gap-x-2 text-[14px] text-muted-foreground">
          You stopped this answer.
          <button type="button" className="cursor-pointer font-medium text-primary hover:underline disabled:opacity-40" onClick={onRetry} disabled={busy}>
            Try again
          </button>
        </p>
      ) : null}
      {turn.status === 'error' && turn.error ? (
        <Callout
          tone="danger"
          title={turn.error.title}
          action={
            turn.prompt ? (
              <Button variant="secondary" size="sm" onClick={onRetry} disabled={busy}>
                <RotateCw aria-hidden="true" /> Try again
              </Button>
            ) : undefined
          }
        >
          {turn.error.description}
        </Callout>
      ) : null}
    </div>
  );
}

function Composer({ chat, inputRef }: { chat: SphereChat; inputRef: React.RefObject<HTMLTextAreaElement> }) {
  const id = useId();
  const [text, setText] = useState('');
  const length = text.length;

  // Grow with the text, up to about six lines
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text, inputRef]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (chat.send(text)) setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const sendButton =
    'relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-ink-foreground transition-[background-color,opacity,transform] duration-200 after:absolute after:-inset-0.5 after:content-[""] hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-95 disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-[18px]';

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-border/70 bg-popover px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
      <div className="flex items-end gap-2 rounded-[24px] border border-input bg-background py-1.5 pl-4 pr-1.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-4 focus-within:ring-ring/20">
        <label htmlFor={id} className="sr-only">
          Message Sphere
        </label>
        <textarea
          id={id}
          ref={inputRef}
          rows={1}
          value={text}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Sphere"
          className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent py-2 text-base leading-6 outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/70 sm:text-[15px]"
        />
        {chat.busy ? (
          <button type="button" className={sendButton} aria-label="Stop answering" onClick={chat.stop}>
            <Square className="fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className={sendButton} aria-label="Send message" disabled={!text.trim()}>
            <ArrowUp strokeWidth={2.4} aria-hidden="true" />
          </button>
        )}
      </div>
      {length > MAX_MESSAGE_LENGTH - 200 ? (
        <p className="mt-1.5 px-2 text-right text-[12px] text-muted-foreground tnum" aria-live="polite">
          {length.toLocaleString('en-IN')} / {MAX_MESSAGE_LENGTH.toLocaleString('en-IN')}
        </p>
      ) : null}
      <p className="mt-2 px-2 text-center text-[12px] leading-4 text-muted-foreground">{SPHERE_DISCLAIMER}</p>
    </form>
  );
}

function HistoryView({
  enabled,
  currentId,
  onOpen,
  onDelete,
}: {
  enabled: boolean;
  currentId: string | null;
  onOpen: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
}) {
  const { api } = useAuth();
  const conversations = useQuery({ queryKey: qk.conversations, queryFn: () => api.assistant.conversations(), enabled });
  const items = conversations.data ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-canvas px-4 py-5">
      {conversations.isError ? (
        <ErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
      ) : conversations.isPending ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="No conversations yet" description="Conversations are kept for 30 days." />
      ) : (
        <>
          <p className="group-label px-4 pb-1.5">Last 30 days</p>
          <ul aria-label="Conversations" className="divide-y divide-border/70 overflow-hidden rounded-2xl bg-card shadow-card">
            {items.map((conversation) => {
              const title = conversation.title?.trim() || 'Untitled conversation';
              const current = conversation.id === currentId;
              return (
                <li key={conversation.id} className="flex items-center">
                  <button
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => onOpen(conversation.id)}
                    className="flex min-h-[56px] min-w-0 flex-1 cursor-pointer flex-col justify-center px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  >
                    <span className={cn('block truncate text-[15px] tracking-[-0.01em]', current ? 'font-semibold' : 'font-medium')}>{title}</span>
                    <span className="block text-[13px] text-muted-foreground tnum">
                      {current ? 'Open now · ' : ''}
                      {updatedFormat.format(new Date(conversation.updatedAt))}
                    </span>
                  </button>
                  <button type="button" className={cn(iconButton, 'mr-1 hover:text-destructive')} aria-label={`Delete “${title}”`} onClick={() => onDelete(conversation)}>
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
