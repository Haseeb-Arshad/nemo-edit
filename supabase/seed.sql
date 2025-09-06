-- Sample categories, styles, prompt presets, qualities

insert into public.style_categories (slug, name, description, sort_order)
values
  ('anime', 'Anime', 'Stylized anime and manga aesthetics', 10),
  ('cinematic', 'Cinematic', 'Film-like color grading and lighting', 20),
  ('realistic', 'Realistic', 'Photorealistic depictions and portraits', 30)
on conflict (slug) do nothing;

insert into public.image_styles (slug, name, category_id, description, base_prompt, attributes, sort_order)
select 'anime-general', 'Anime General', c.id, 'General anime look', 'Anime style, clean lines, bold shading, expressive eyes', '{"supports_filters": true}', 10
from public.style_categories c where c.slug = 'anime'
on conflict (slug) do nothing;

insert into public.image_styles (slug, name, category_id, description, base_prompt, attributes, sort_order)
select 'cinematic-portrait', 'Cinematic Portrait', c.id, 'Moody portrait look', 'Cinematic portrait, dramatic lighting, shallow depth of field', '{"supports_filters": true}', 10
from public.style_categories c where c.slug = 'cinematic'
on conflict (slug) do nothing;

insert into public.prompt_presets (slug, name, style_id, prompt_template, variables, active)
select 'anime-hero', 'Anime Hero Portrait', s.id,
  'Heroic anime portrait with dynamic lighting and crisp line art. {{extra}}', '{"extra": {"type": "string"}}', true
from public.image_styles s where s.slug = 'anime-general'
on conflict (slug) do nothing;

insert into public.qualities (slug, name, config, sort_order)
values
  ('standard', 'Standard', '{"sharpness": 0.5}', 10),
  ('high', 'High', '{"sharpness": 0.8}', 20)
on conflict (slug) do nothing;

