-- ============================================================
-- AI 起名 · Supabase 建表 SQL
-- 在 Supabase Dashboard → SQL Editor 中执行即可
-- ============================================================

-- 1) 起名记录表
create table if not exists public.name_generations (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  -- 用户输入
  surname      text,               -- 姓氏（可选）
  gender       text,               -- 性别：男孩 / 女孩 / 中性
  name_type    text,               -- 类型（同 gender，兼容历史字段，可留空）
  style        text,               -- 风格偏好
  keywords     text,               -- 希望融入的关键字
  requirements text,               -- 起名需求 / 寓意描述

  -- AI 生成结果
  result       text,               -- 完整流式输出（3 组名字 + 寓意）
  model        text not null,      -- 使用的模型，如 kimi-k3.1-pro
  raw_response jsonb               -- 可选：原始结构化响应
);

-- 2) 常用索引
create index if not exists idx_name_generations_created_at
  on public.name_generations (created_at desc);

create index if not exists idx_name_generations_model
  on public.name_generations (model);

-- 3) 行级安全策略
-- 若使用 SUPABASE_ANON_KEY（前端公钥）落库，需开启 RLS 并放行 INSERT；
-- 若使用 SUPABASE_SERVICE_ROLE_KEY（服务端密钥，推荐），可跳过第 3 步。
alter table public.name_generations enable row level security;

create policy "允许匿名插入起名记录"
  on public.name_generations
  for insert
  to anon
  with check (true);

-- 可选：允许匿名查询自己或全部记录（按需开启，谨慎使用）
-- create policy "允许匿名查询起名记录"
--   on public.name_generations
--   for select
--   to anon
--   using (true);
