-- Create schema for image generation system

-- Enable extensions (if not already enabled in the project)
-- create extension if not exists "pgcrypto"; -- for gen_random_uuid

-- Categories for styles (e.g., Anime, Cinematic, Realistic)
create table if not exists public.style_categories (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Image styles within categories
create table if not exists public.image_styles (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.style_categories(id) on delete set null,
  slug text unique not null,
  name text not null,
  description text,
  base_prompt text,
  attributes jsonb,
  active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Prompt presets, optionally tied to a style
create table if not exists public.prompt_presets (
  id uuid primary key default gen_random_uuid(),
  style_id uuid references public.image_styles(id) on delete set null,
  slug text unique,
  name text not null,
  prompt_template text not null,
  variables jsonb,
  active boolean default true,
  created_at timestamptz default now()
);

-- Optional: filters library
create table if not exists public.filters (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  type text not null, -- e.g., effect, tone, lens
  config jsonb,       -- schema-free knob ranges, defaults, etc.
  active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.style_filters (
  style_id uuid references public.image_styles(id) on delete cascade,
  filter_id uuid references public.filters(id) on delete cascade,
  default_strength numeric,
  primary key (style_id, filter_id)
);

-- Optional: quality presets
create table if not exists public.qualities (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  model text,
  config jsonb,
  active boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Generation tasks/jobs
create table if not exists public.generation_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  status text not null check (status in ('queued','running','succeeded','failed')),
  style_id uuid references public.image_styles(id) on delete set null,
  prompt_id uuid references public.prompt_presets(id) on delete set null,
  prompt text,
  params jsonb,
  input_image_path text,
  output_text text,
  error text,
  created_at timestamptz default now(),
  completed_at timestamptz
);

-- Generated output images
create table if not exists public.generation_outputs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.generation_tasks(id) on delete cascade,
  index int not null,
  storage_bucket text not null,
  storage_path text not null,
  mime text,
  size int,
  width int,
  height int,
  metadata jsonb,
  created_at timestamptz default now()
);

-- Helpful indexes
create index if not exists idx_image_styles_category on public.image_styles(category_id);
create index if not exists idx_prompt_presets_style on public.prompt_presets(style_id);
create index if not exists idx_generation_outputs_task on public.generation_outputs(task_id);

-- Basic RLS (adjust as needed for your app). For now, allow anon select on catalogs.
alter table public.style_categories enable row level security;
alter table public.image_styles enable row level security;
alter table public.prompt_presets enable row level security;
alter table public.filters enable row level security;
alter table public.style_filters enable row level security;
alter table public.qualities enable row level security;
alter table public.generation_tasks enable row level security;
alter table public.generation_outputs enable row level security;

-- Catalog read policies (public read). Restrict write to service role only.
do $$ begin
  create policy read_style_categories on public.style_categories for select using (true);
exception when others then null; end $$;
do $$ begin
  create policy read_image_styles on public.image_styles for select using (true);
exception when others then null; end $$;
do $$ begin
  create policy read_prompt_presets on public.prompt_presets for select using (true);
exception when others then null; end $$;
do $$ begin
  create policy read_filters on public.filters for select using (true);
exception when others then null; end $$;
do $$ begin
  create policy read_style_filters on public.style_filters for select using (true);
exception when others then null; end $$;
do $$ begin
  create policy read_qualities on public.qualities for select using (true);
exception when others then null; end $$;

-- Tasks/outputs: public read for now (adjust later to per-user once auth is added)
do $$ begin
  create policy read_generation_tasks on public.generation_tasks for select using (true);
exception when others then null; end $$;
do $$ begin
  create policy read_generation_outputs on public.generation_outputs for select using (true);
exception when others then null; end $$;

