import { buildAvatarSvg } from "./avatarSvg";

interface UserAvatarProps {
  distinctId: string;
  size?: number;
  countryCode?: string;
  eventCount?: number;
}

export function UserAvatar({ distinctId, size = 28, countryCode, eventCount }: UserAvatarProps) {
  const svg = buildAvatarSvg(distinctId, countryCode, eventCount);
  return (
    <div
      style={{
        width: size,
        height: size * 1.3,
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
