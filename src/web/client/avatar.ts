export interface PixelAvatarView {
  sprite: number;
  hair: string;
  skin: string;
  outfit: string;
  accent: string;
  accessory: 'none' | 'glasses' | 'beret' | 'cap' | 'ribbon' | 'beard';
}

const AVATAR_FALLBACKS: readonly PixelAvatarView[] = [
  { sprite: 0, hair: '#20242b', skin: '#f0c7a0', outfit: '#59697d', accent: '#d47455', accessory: 'none' },
  { sprite: 1, hair: '#1b1c20', skin: '#805338', outfit: '#466763', accent: '#b79272', accessory: 'glasses' },
  { sprite: 2, hair: '#3a3c42', skin: '#efc6a2', outfit: '#5a636d', accent: '#bc6758', accessory: 'beret' },
  { sprite: 3, hair: '#e5e4df', skin: '#efc9a8', outfit: '#66616a', accent: '#b76358', accessory: 'cap' },
  { sprite: 4, hair: '#d9a534', skin: '#f1c59d', outfit: '#486691', accent: '#9d68ac', accessory: 'ribbon' },
  { sprite: 5, hair: '#d55388', skin: '#f0c3a0', outfit: '#685b91', accent: '#e08aae', accessory: 'beret' },
  { sprite: 6, hair: '#a85c32', skin: '#efc29a', outfit: '#a27250', accent: '#ead0a6', accessory: 'none' },
  { sprite: 7, hair: '#766054', skin: '#edc29e', outfit: '#716051', accent: '#c8b08e', accessory: 'beard' },
];

const ACCESSORIES = new Set<PixelAvatarView['accessory']>(['none', 'glasses', 'beret', 'cap', 'ribbon', 'beard']);

/** 把新版或旧版快照统一成可直接渲染的头像数据。 */
export function normalizePixelAvatar(
  avatar: Partial<PixelAvatarView> | null | undefined,
  spriteIndex = 0,
): PixelAvatarView {
  const sprite = Number.isFinite(avatar?.sprite) ? Math.floor(Number(avatar?.sprite)) : Math.floor(spriteIndex);
  const slot = ((sprite % AVATAR_FALLBACKS.length) + AVATAR_FALLBACKS.length) % AVATAR_FALLBACKS.length;
  const fallback = AVATAR_FALLBACKS[slot];
  const accessory = typeof avatar?.accessory === 'string' && ACCESSORIES.has(avatar.accessory)
    ? avatar.accessory
    : fallback.accessory;
  return {
    sprite: slot,
    hair: safeColor(avatar?.hair, fallback.hair),
    skin: safeColor(avatar?.skin, fallback.skin),
    outfit: safeColor(avatar?.outfit, fallback.outfit),
    accent: safeColor(avatar?.accent, fallback.accent),
    accessory,
  };
}

export function pixelAvatarMarkup(
  name: string,
  avatar: PixelAvatarView | null | undefined,
  className = '',
): string {
  const normalized = normalizePixelAvatar(avatar);
  const safeName = escapeAttribute(name);
  const style = `--avatar-hair:${normalized.hair};--avatar-skin:${normalized.skin};--avatar-outfit:${normalized.outfit};--avatar-accent:${normalized.accent}`;
  return `<span class="pixel-avatar ${escapeAttribute(className)}" data-accessory="${escapeAttribute(normalized.accessory)}" data-sprite="${normalized.sprite}" style="${style}" role="img" aria-label="${safeName}的像素头像"><i class="pixel-avatar__hair"></i><i class="pixel-avatar__face"></i><i class="pixel-avatar__eyes"></i><i class="pixel-avatar__body"></i><i class="pixel-avatar__accent"></i><i class="pixel-avatar__accessory"></i></span>`;
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
