/**
 * Supabase database schema types (Phase 1 MVP slice).
 *
 * These mirror `supabase/schema.sql` (the seed for the real project).
 * Keep in sync with that file — both describe the same tables.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type WeekStartDay = 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          name: string;
          week_start_day: WeekStartDay;
          timezone: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          name: string;
          week_start_day: WeekStartDay;
          timezone: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          week_start_day?: WeekStartDay;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      groups: {
        Row: {
          id: string;
          name: string;
          /** Optional pair team name (nullable; unset = UI falls back to partner name). */
          team_name: string | null;
          creator_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          team_name?: string | null;
          creator_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          team_name?: string | null;
          creator_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'groups_creator_id_fkey';
            columns: ['creator_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      memberships: {
        Row: {
          id: string;
          group_id: string;
          user_id: string;
          weekly_goal: number;
          role: 'member' | 'admin';
          /**
           * V1.1 Build #2 (S slice): the member's OWN optional miss promise
           * ("If I miss, I owe you: ___", ≤80 chars, personal accountability
           * note — NOT a wager/enforcement system). Null = never set; empty
           * string = cleared. Own-row RLS only: never readable/writable by the
           * partner in this build.
           */
          miss_promise: string | null;
          /**
           * Treats/Promises ledger: the member's note is "to" this witness.
           * Null = not chosen yet; the witness auto-resolves to the other
           * member in a 2-person group and is picked by the maker in 3+.
           * ON DELETE SET NULL never cascades; own-row RLS only.
           */
          miss_witness_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          user_id: string;
          weekly_goal: number;
          role?: 'member' | 'admin';
          miss_promise?: string | null;
          miss_witness_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          user_id?: string;
          weekly_goal?: number;
          role?: 'member' | 'admin';
          miss_promise?: string | null;
          miss_witness_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memberships_group_id_fkey';
            columns: ['group_id'];
            referencedRelation: 'groups';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memberships_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      /** Treats/Promises ledger — one row per missed-week promise. Pair-private
       * by RLS: selectable ONLY by the maker (user_id) or the snapshotted
       * witness (witness_id) — never the whole group. Writes are RPC-only
       * (record_missed_promise / resolve_promise); no INSERT/UPDATE/DELETE
       * policies exist. */
      promise_entries: {
        Row: {
          id: string;
          membership_id: string;
          /** The promise-MAKER (the member who missed). */
          user_id: string;
          /** SNAPSHOT of the witness at miss time — history never rewrites. */
          witness_id: string;
          /** The maker's own note, 1–80 chars, trimmed at creation. */
          promise_text: string;
          /** The missed week (unique per maker-membership + week). */
          week_start: string;
          state: 'open' | 'kept' | 'let_go';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          membership_id: string;
          user_id: string;
          witness_id: string;
          promise_text: string;
          week_start: string;
          state?: 'open' | 'kept' | 'let_go';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          membership_id?: string;
          user_id?: string;
          witness_id?: string;
          promise_text?: string;
          week_start?: string;
          state?: 'open' | 'kept' | 'let_go';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'promise_entries_membership_id_fkey';
            columns: ['membership_id'];
            referencedRelation: 'memberships';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'promise_entries_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'promise_entries_witness_id_fkey';
            columns: ['witness_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      workouts: {
        Row: {
          id: string;
          user_id: string;
          group_id: string | null;
          /** Storage path inside the private `workouts` bucket — NEVER a public URL. */
          photo_path: string;
          /** Environment-shot storage path (v1.0 dual-capture, 2nd live shot —
           * always unfiltered). NULL on legacy rows predating dual-capture. */
          photo_env: string | null;
          /** Optional caption — NULL or 1–140 chars (DB check constraint). */
          caption: string | null;
          /** Server-set on insert (default now()); the photo's proof timestamp. */
          logged_at: string;
          workout_type: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          group_id?: string | null;
          photo_path: string;
          photo_env?: string | null;
          caption?: string | null;
          logged_at?: string;
          workout_type?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          group_id?: string | null;
          photo_path?: string;
          photo_env?: string | null;
          caption?: string | null;
          logged_at?: string;
          workout_type?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workouts_user_id_fkey';
            columns: ['user_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workouts_group_id_fkey';
            columns: ['group_id'];
            referencedRelation: 'groups';
            referencedColumns: ['id'];
          },
        ];
      };
      analytics_events: {
        Row: {
          id: string;
          event_name: string;
          action: string | null;
          anonymous_install_id: string | null;
          session_id: string | null;
          user_id: string | null;
          group_id: string | null;
          source_id: string | null;
          occurred_at: string;
          app_version: string | null;
          properties: Json;
        };
        Insert: {
          id?: string;
          event_name: string;
          action?: string | null;
          anonymous_install_id?: string | null;
          session_id?: string | null;
          user_id?: string | null;
          group_id?: string | null;
          source_id?: string | null;
          occurred_at?: string;
          app_version?: string | null;
          properties?: Json;
        };
        Update: {
          id?: string;
          event_name?: string;
          action?: string | null;
          anonymous_install_id?: string | null;
          session_id?: string | null;
          user_id?: string | null;
          group_id?: string | null;
          source_id?: string | null;
          occurred_at?: string;
          app_version?: string | null;
          properties?: Json;
        };
        Relationships: [];
      };
      weekly_results: {
        Row: {
          id: string;
          user_id: string;
          group_id: string;
          week_start_at: string;
          week_end_at: string;
          weekly_goal_snapshot: number;
          workout_count: number;
          completed: boolean;
          nudge_present: boolean | null;
          finalized_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          group_id: string;
          week_start_at: string;
          week_end_at: string;
          weekly_goal_snapshot: number;
          workout_count?: number;
          completed?: boolean;
          nudge_present?: boolean | null;
          finalized_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          group_id?: string;
          week_start_at?: string;
          week_end_at?: string;
          weekly_goal_snapshot?: number;
          workout_count?: number;
          completed?: boolean;
          nudge_present?: boolean | null;
          finalized_at?: string;
        };
        Relationships: [];
      };
      notification_preferences: {
        Row: {
          user_id: string;
          master_enabled: boolean;
          invite_accepted_enabled: boolean;
          partner_logged_enabled: boolean;
          missed_week_enabled: boolean;
          pending_invite_enabled: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          master_enabled?: boolean;
          invite_accepted_enabled?: boolean;
          partner_logged_enabled?: boolean;
          missed_week_enabled?: boolean;
          pending_invite_enabled?: boolean;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          master_enabled?: boolean;
          invite_accepted_enabled?: boolean;
          partner_logged_enabled?: boolean;
          missed_week_enabled?: boolean;
          pending_invite_enabled?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      push_devices: {
        Row: {
          id: string;
          user_id: string;
          expo_push_token: string;
          platform: string | null;
          app_version: string | null;
          last_seen_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          expo_push_token: string;
          platform?: string | null;
          app_version?: string | null;
          last_seen_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          expo_push_token?: string | null;
          platform?: string | null;
          app_version?: string | null;
          last_seen_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      push_deliveries: {
        Row: {
          id: string;
          user_id: string;
          dedupe_key: string;
          kind: string;
          status: 'queued' | 'sent' | 'suppressed' | 'failed';
          suppressed_reason: string | null;
          error: string | null;
          created_at: string;
          sent_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          dedupe_key: string;
          kind: string;
          status?: 'queued' | 'sent' | 'suppressed' | 'failed';
          suppressed_reason?: string | null;
          error?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          dedupe_key?: string | null;
          kind?: string | null;
          status?: 'queued' | 'sent' | 'suppressed' | 'failed';
          suppressed_reason?: string | null;
          error?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Relationships: [];
      };
      invites: {
        Row: {
          id: string;
          /** The user who created the invite (RLS: visible only to them). */
          inviter_id: string;
          /** Random, readable code — the capability to pair. No expiry in MVP. */
          token: string;
          /** Optional pre-addressed email (link-based invites leave it null). */
          invitee_email: string | null;
          status: 'pending' | 'accepted';
          created_at: string;
          accepted_at: string | null;
        };
        Insert: {
          id?: string;
          inviter_id: string;
          token: string;
          invitee_email?: string | null;
          status?: 'pending' | 'accepted';
          created_at?: string;
          accepted_at?: string | null;
        };
        Update: {
          id?: string;
          inviter_id?: string;
          token?: string;
          invitee_email?: string | null;
          status?: 'pending' | 'accepted';
          created_at?: string;
          accepted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'invites_inviter_id_fkey';
            columns: ['inviter_id'];
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      /** Leak-proof pair check (SECURITY DEFINER): true only when auth.uid() is paired with p_other. */
      is_paired_with: {
        Args: { p_other: string };
        Returns: boolean;
      };
      /** Authenticated: resolve auth.uid()'s shared group — { group_id, member_ids (excluding self), member_count } (all null/empty when solo). SECURITY DEFINER. */
      my_group: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** Public (unauthenticated ok): resolve a pending invite code to the minimal Accept-screen info. */
      get_invite: {
        Args: { p_token: string };
        Returns: Json;
      };
      /** Authenticated: join the inviter's current shared group (creates it when the inviter is solo). One transaction. */
      join_group: {
        Args: { p_token: string };
        Returns: Json;
      };
      /** Authenticated: remove the current auth.uid() from their shared group (dissolves at <= 2 seats; reassigns creator). */
      leave_group: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** v1.0 max group size = 3 (you + 2 partners); the future Spotter+ paid tier raises this in one place. */
      group_capacity: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      /** Authenticated only: permanently delete the current auth.uid()'s account + data (App Store 5.1.1(v)). */
      delete_account: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      /** Treats/Promises ledger: called at week rollover when the maker missed. Idempotent + never-shaming (no note set -> {ok:true, created:false}); re-validates the witness is a current co-member (stranger-witness backstop). SECURITY DEFINER, authenticated only. */
      record_missed_promise: {
        Args: { p_week_start: string };
        Returns: Json;
      };
      /** Treats/Promises ledger: settle an entry — promise-maker ONLY, witness is passive. Only open -> kept / let_go. SECURITY DEFINER, authenticated only. */
      resolve_promise: {
        Args: { p_entry_id: string; p_state: string };
        Returns: Json;
      };
      /** Treats/Promises ledger: note-set write path (trim + <=80; empty clears both columns). 2-person group auto-resolves the witness; 3+ requires a co-member pick. SECURITY DEFINER, authenticated only. */
      set_miss_note: {
        Args: { p_text: string; p_witness_id: string | null };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}