CREATE TYPE "public"."user_role" AS ENUM('super_user', 'admin', 'team_member');--> statement-breakpoint
CREATE TYPE "public"."os_type" AS ENUM('windows', 'macos', 'linux');--> statement-breakpoint
CREATE TYPE "public"."productivity_class" AS ENUM('productive', 'unproductive', 'neutral', 'undefined');--> statement-breakpoint
CREATE TYPE "public"."connectivity_state" AS ENUM('online', 'offline', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."engagement_state" AS ENUM('active', 'passive', 'idle');--> statement-breakpoint
CREATE TYPE "public"."session_state" AS ENUM('unlocked', 'locked', 'suspended', 'monitoring_paused');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('pending', 'acknowledged', 'downloading', 'installing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."command_type" AS ENUM('lock_screen', 'logout_user', 'update_config', 'unlock_screen', 'update_agent', 'set_usb_block', 'restart', 'shutdown');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'team_member' NOT NULL,
	"managed_by_id" uuid,
	"self_dashboard_enabled" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hardware_hash" text NOT NULL,
	"system_name" text NOT NULL,
	"os_type" "os_type" NOT NULL,
	"agent_version" text,
	"assigned_user_id" uuid,
	"enrolled_via_token_id" uuid,
	"secret_hash" text NOT NULL,
	"consent_acknowledged_at" timestamp with time zone,
	"consent_name" text,
	"enrolled_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"is_locked" boolean DEFAULT false NOT NULL,
	"locked_until" timestamp with time zone,
	"screenshot_min_minutes" integer DEFAULT 5 NOT NULL,
	"screenshot_max_minutes" integer DEFAULT 15 NOT NULL,
	"idle_threshold_seconds" integer DEFAULT 120 NOT NULL,
	"sync_interval_seconds" integer DEFAULT 300 NOT NULL,
	"monitoring_enabled" boolean DEFAULT true NOT NULL,
	"device_group" text DEFAULT 'Unassigned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_hardware_hash_unique" UNIQUE("hardware_hash")
);
--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"created_by_id" uuid,
	"assigned_user_id" uuid,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "app_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pattern" text NOT NULL,
	"display_name" text NOT NULL,
	"classification" "productivity_class" DEFAULT 'undefined' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid,
	"segment_id" uuid NOT NULL,
	"sequence_namespace" text,
	"sequence" integer NOT NULL,
	"process_name" text NOT NULL,
	"window_title" text,
	"url" text,
	"category_id" uuid,
	"engagement_state" "engagement_state" DEFAULT 'active' NOT NULL,
	"session_state" "session_state" DEFAULT 'unlocked' NOT NULL,
	"connectivity_state" "connectivity_state" DEFAULT 'unknown' NOT NULL,
	"transition_reason" text,
	"policy_version" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"elapsed_milliseconds" integer NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"idle_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_logs_device_segment_idx" UNIQUE("device_id","segment_id"),
	CONSTRAINT "activity_logs_device_sequence_idx" UNIQUE("device_id","sequence_namespace","sequence")
);
--> statement-breakpoint
CREATE TABLE "screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid,
	"storage_key" text NOT NULL,
	"file_size_bytes" integer DEFAULT 0 NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"summary_date" date NOT NULL,
	"productive_seconds" integer DEFAULT 0 NOT NULL,
	"unproductive_seconds" integer DEFAULT 0 NOT NULL,
	"neutral_seconds" integer DEFAULT 0 NOT NULL,
	"undefined_seconds" integer DEFAULT 0 NOT NULL,
	"idle_seconds" integer DEFAULT 0 NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"productivity_score" numeric(5, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"issued_by_id" uuid,
	"cancelled_by_id" uuid,
	"command_type" "command_type" NOT NULL,
	"payload" text,
	"status" "command_status" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"cancel_reason" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "attendance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid,
	"device_group" text,
	"work_start_time" text DEFAULT '09:00' NOT NULL,
	"half_day_threshold_hours" real DEFAULT 4 NOT NULL,
	"required_hours_normal" real DEFAULT 7.5 NOT NULL,
	"required_hours_friday" real DEFAULT 7 NOT NULL,
	"working_days" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL,
	"holidays" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"alert_type" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_enrolled_via_token_id_enrollment_tokens_id_fk" FOREIGN KEY ("enrolled_via_token_id") REFERENCES "public"."enrollment_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_categories" ADD CONSTRAINT "app_categories_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_category_id_app_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."app_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screenshots" ADD CONSTRAINT "screenshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_alerts" ADD CONSTRAINT "device_alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_categories_pattern_idx" ON "app_categories" USING btree ("pattern");--> statement-breakpoint
CREATE INDEX "activity_logs_device_time_idx" ON "activity_logs" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE INDEX "activity_logs_user_time_idx" ON "activity_logs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "screenshots_device_captured_idx" ON "screenshots" USING btree ("device_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_summaries_user_date_idx" ON "daily_summaries" USING btree ("user_id","summary_date");--> statement-breakpoint
CREATE INDEX "device_commands_device_status_idx" ON "device_commands" USING btree ("device_id","status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_settings_global_uniq" ON "attendance_settings" USING btree ((("device_id" IS NULL))) WHERE "attendance_settings"."device_id" is null and "attendance_settings"."device_group" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_settings_device_uniq" ON "attendance_settings" USING btree ("device_id") WHERE "attendance_settings"."device_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_settings_group_uniq" ON "attendance_settings" USING btree ("device_group") WHERE "attendance_settings"."device_group" is not null;