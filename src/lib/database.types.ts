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
          creator_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          creator_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}