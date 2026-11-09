import { supabaseAnon, supabaseForUser } from './supabase.js';

/** Conversaciones persistentes estilo Claude: lista de hilos + mensajes. */

function clientFor(token: string | null) {
  return token ? supabaseForUser(token) : supabaseAnon();
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export async function listConversations(userId: string, token: string | null): Promise<Conversation[]> {
  const sb = clientFor(token);
  if (!sb) return [];
  const { data } = await sb
    .from('genesus_conversations')
    .select('id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(200);
  return (data ?? []) as Conversation[];
}

export async function createConversation(
  userId: string,
  token: string | null,
  title = 'Nueva conversación',
): Promise<Conversation | null> {
  const sb = clientFor(token);
  if (!sb) return null;
  const { data, error } = await sb
    .from('genesus_conversations')
    .insert({ user_id: userId, title })
    .select('id, title, created_at, updated_at')
    .single();
  if (error) {
    console.error(`[conv] crear: ${error.message}`);
    return null;
  }
  return data as Conversation;
}

export async function deleteConversation(userId: string, token: string | null, id: string): Promise<boolean> {
  const sb = clientFor(token);
  if (!sb) return false;
  const { error } = await sb.from('genesus_conversations').delete().eq('id', id);
  return !error;
}

export async function renameConversation(
  userId: string,
  token: string | null,
  id: string,
  title: string,
): Promise<boolean> {
  const sb = clientFor(token);
  if (!sb) return false;
  const { error } = await sb.from('genesus_conversations').update({ title }).eq('id', id);
  return !error;
}

export async function listMessages(
  userId: string,
  token: string | null,
  conversationId: string,
): Promise<Message[]> {
  const sb = clientFor(token);
  if (!sb) return [];
  const { data } = await sb
    .from('genesus_messages')
    .select('id, role, content, meta, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  return (data ?? []) as Message[];
}

export async function addMessage(
  token: string | null,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const sb = clientFor(token);
  if (!sb) return;
  await sb.from('genesus_messages').insert({ conversation_id: conversationId, role, content, meta });
  await sb.from('genesus_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
}

/** Pone título a la conversación a partir del primer mensaje (si sigue por defecto). */
export async function maybeTitle(
  token: string | null,
  conversationId: string,
  firstMessage: string,
): Promise<void> {
  const sb = clientFor(token);
  if (!sb) return;
  const { data } = await sb
    .from('genesus_conversations')
    .select('title')
    .eq('id', conversationId)
    .single();
  if (data && data.title === 'Nueva conversación') {
    const title = firstMessage.trim().slice(0, 60) || 'Conversación';
    await sb.from('genesus_conversations').update({ title }).eq('id', conversationId);
  }
}

/** Últimos N mensajes como historial para dar contexto al modelo. */
export async function recentHistory(
  token: string | null,
  conversationId: string,
  limit = 8,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const msgs = await listMessages('', token, conversationId);
  return msgs.slice(-limit).map((m) => ({ role: m.role, content: m.content }));
}
