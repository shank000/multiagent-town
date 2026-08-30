export interface PixelAvatarView {
  sprite: number;
  hair: string;
  skin: string;
  outfit: string;
  accent: string;
  accessory: 'none' | 'glasses' | 'beret' | 'cap' | 'ribbon' | 'beard';
}

export function pixelAvatarMarkup(
  name: string,
  avatar: PixelAvatarView,
  className = '',
): string {
  const safeName = escapeAttribute(name);
  const style = `--avatar-hair:${safeColor(avatar.hair)};--avatar-skin:${safeColor(avatar.skin)};--avatar-outfit:${safeColor(avatar.outfit)};--avatar-accent:${safeColor(avatar.accent)}`;
  return `<span class="pixel-avatar ${escapeAttribute(className)}" data-accessory="${escapeAttribute(avatar.accessory)}" data-sprite="${Math.max(0, Math.min(7, Math.floor(avatar.sprite)))}" style="${style}" role="img" aria-label="${safeName}的像素头像"><i class="pixel-avatar__hair"></i><i class="pixel-avatar__face"></i><i class="pixel-avatar__eyes"></i><i class="pixel-avatar__body"></i><i class="pixel-avatar__accent"></i><i class="pixel-avatar__accessory"></i></span>`;
}

function safeColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#777777';
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
