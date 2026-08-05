CREATE TYPE "public"."currency" AS ENUM('USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'LEFT');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('FEMALE', 'MALE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."refresh_token_revocation" AS ENUM('ROTATED', 'LOGGED_OUT', 'REUSE_DETECTED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('HR_ADMIN', 'HR_VIEWER', 'MANAGER', 'EMPLOYEE');--> statement-breakpoint
CREATE TABLE "compensation_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" integer NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" "currency" NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compensation_amount_positive" CHECK ("compensation_records"."amount_minor" > 0),
	CONSTRAINT "compensation_amount_within_exact_range" CHECK ("compensation_records"."amount_minor" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"country" char(2) NOT NULL,
	"department_id" integer NOT NULL,
	"job_level_id" integer NOT NULL,
	"job_title" text,
	"hire_date" date NOT NULL,
	"manager_id" integer,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"left_on" date,
	"gender" "gender",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employee_left_on_matches_status" CHECK (("employees"."status" = 'LEFT') = ("employees"."left_on" IS NOT NULL)),
	CONSTRAINT "employee_left_on_after_hire" CHECK ("employees"."left_on" IS NULL OR "employees"."left_on" >= "employees"."hire_date")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"currency" "currency" PRIMARY KEY NOT NULL,
	"rate_to_usd" numeric(18, 8) NOT NULL,
	"as_of" date NOT NULL,
	CONSTRAINT "fx_rate_positive" CHECK ("fx_rates"."rate_to_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	CONSTRAINT "job_levels_name_unique" UNIQUE("name"),
	CONSTRAINT "job_levels_rank_unique" UNIQUE("rank")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" "refresh_token_revocation",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "refresh_token_revocation_complete" CHECK (("refresh_tokens"."revoked_at" IS NULL) = ("refresh_tokens"."revoked_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "salary_bands" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_level_id" integer NOT NULL,
	"country" char(2) NOT NULL,
	"currency" "currency" NOT NULL,
	"min_minor" bigint NOT NULL,
	"mid_minor" bigint NOT NULL,
	"max_minor" bigint NOT NULL,
	CONSTRAINT "salary_band_ordered" CHECK ("salary_bands"."min_minor" > 0 AND "salary_bands"."min_minor" <= "salary_bands"."mid_minor" AND "salary_bands"."mid_minor" <= "salary_bands"."max_minor")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"employee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_scoped_role_needs_employee" CHECK ("users"."role" IN ('HR_ADMIN', 'HR_VIEWER') OR "users"."employee_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "compensation_records" ADD CONSTRAINT "compensation_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_records" ADD CONSTRAINT "compensation_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_job_level_id_job_levels_id_fk" FOREIGN KEY ("job_level_id") REFERENCES "public"."job_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_employees_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_bands" ADD CONSTRAINT "salary_bands_job_level_id_job_levels_id_fk" FOREIGN KEY ("job_level_id") REFERENCES "public"."job_levels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compensation_employee_effective_idx" ON "compensation_records" USING btree ("employee_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_no_identical_record_idx" ON "compensation_records" USING btree ("employee_id","effective_from","amount_minor","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_email_lower_idx" ON "employees" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "employees_manager_idx" ON "employees" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "employees_department_idx" ON "employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "employees_job_level_idx" ON "employees" USING btree ("job_level_id");--> statement-breakpoint
CREATE INDEX "employees_country_idx" ON "employees" USING btree ("country");--> statement-breakpoint
CREATE INDEX "employees_status_idx" ON "employees" USING btree ("status");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "salary_bands_level_country_idx" ON "salary_bands" USING btree ("job_level_id","country");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));