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
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          user_id: string;
          weekly_goal: number;
          role?: 'member' | 'admin';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          group_id?: string;
          user_id?: string;
          weekly_goal?: number;
          role?: 'member' | 'admin';
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
      workouts: {
        Row: {
          id: string;
          user_id: string;
          group_id: string | null;
          /** Storage path inside the private `workouts` bucket — NEVER a public URL. */
          photo_path: string;
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
          logged_at?: string;
          workout_type?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          group_id?: string | null;
          photo_path?: string;
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
      /** Public (unauthenticated ok): resolve a pending invite code to the minimal Accept-screen info. */
      get_invite: {
        Args: { p_token: string };
        Returns: Json;
      };
      /** Authenticated: pair the current auth.uid() with the inviter of this token (one transaction). */
      accept_invite: {
        Args: { p_token: string };
        Returns: Json;
      };
      /** Authenticated: unpair the current auth.uid() from their 2-member pair group (both sides return to solo). */
      unpair: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      /** Authenticated only: permanently delete the current auth.uid()'s account + data (App Store 5.1.1(v)). */
      delete_account: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}