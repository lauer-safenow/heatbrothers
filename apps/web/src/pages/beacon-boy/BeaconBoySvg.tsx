export default function BeaconBoySvg({ size = 80 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 260"
      width={size}
      height={size * 1.3}
      style={{ flexShrink: 0 }}
    >
      {/* Beacon signal arcs */}
      <g stroke="#6366f1" fill="none" strokeWidth="2.5" opacity="0.5">
        <path d="M60 30 Q50 10 60 -5" />
        <path d="M140 30 Q150 10 140 -5" />
        <path d="M50 35 Q35 10 50 -15" />
        <path d="M150 35 Q165 10 150 -15" />
        <path d="M40 40 Q20 10 40 -25" />
        <path d="M160 40 Q180 10 160 -25" />
      </g>

      {/* Beacon antenna on head */}
      <line x1="100" y1="28" x2="100" y2="5" stroke="#a5b4fc" strokeWidth="3" strokeLinecap="round" />
      <circle cx="100" cy="3" r="5" fill="#6366f1">
        <animate attributeName="opacity" values="1;0.3;1" dur="1.5s" repeatCount="indefinite" />
      </circle>
      <circle cx="100" cy="3" r="8" fill="none" stroke="#6366f1" strokeWidth="1.5" opacity="0.4">
        <animate attributeName="r" values="8;14;8" dur="1.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.4;0;0.4" dur="1.5s" repeatCount="indefinite" />
      </circle>

      {/* Head - androgynous soft face */}
      <ellipse cx="100" cy="48" rx="24" ry="26" fill="#d4a88c" />
      {/* Hair - longer, flowing, androgynous */}
      <path d="M76 42 Q74 20 88 18 Q100 14 112 18 Q126 20 124 42 Q126 34 128 45 Q130 30 122 16 Q112 8 100 6 Q88 8 78 16 Q70 30 72 45 Z" fill="#4a3728" />
      {/* Side hair strands */}
      <path d="M76 42 Q70 55 72 68" stroke="#4a3728" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M124 42 Q130 55 128 68" stroke="#4a3728" strokeWidth="5" fill="none" strokeLinecap="round" />
      {/* Eyes - larger, expressive */}
      <ellipse cx="89" cy="48" rx="4.5" ry="5" fill="#1e293b" />
      <ellipse cx="111" cy="48" rx="4.5" ry="5" fill="#1e293b" />
      <circle cx="90.5" cy="46.5" r="1.5" fill="white" />
      <circle cx="112.5" cy="46.5" r="1.5" fill="white" />
      {/* Subtle eyelashes */}
      <path d="M84 44 Q86 42 88 43" stroke="#1e293b" strokeWidth="1" fill="none" />
      <path d="M116 44 Q114 42 112 43" stroke="#1e293b" strokeWidth="1" fill="none" />
      {/* Soft smile */}
      <path d="M93 58 Q100 63 107 58" stroke="#8b5e3c" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      {/* Slight blush */}
      <circle cx="83" cy="55" r="5" fill="#e8a0a0" opacity="0.3" />
      <circle cx="117" cy="55" r="5" fill="#e8a0a0" opacity="0.3" />

      {/* EXTREMELY MUSCULAR neck */}
      <rect x="85" y="72" width="30" height="14" rx="4" fill="#d4a88c" />
      {/* Neck tendons */}
      <line x1="92" y1="73" x2="90" y2="85" stroke="#c49478" strokeWidth="1" />
      <line x1="108" y1="73" x2="110" y2="85" stroke="#c49478" strokeWidth="1" />

      {/* MASSIVE trapezius muscles */}
      <path d="M55 100 Q70 78 85 85 L115 85 Q130 78 145 100 L140 108 Q120 95 100 95 Q80 95 60 108 Z" fill="#6366f1" />

      {/* ENORMOUS shoulders - deltoids bulging */}
      <ellipse cx="48" cy="110" rx="22" ry="16" fill="#6366f1" />
      <ellipse cx="152" cy="110" rx="22" ry="16" fill="#6366f1" />
      {/* Deltoid striations */}
      <path d="M38 105 Q45 100 50 108" stroke="#4f46e5" strokeWidth="1" fill="none" />
      <path d="M162 105 Q155 100 150 108" stroke="#4f46e5" strokeWidth="1" fill="none" />

      {/* Torso - massive V-taper chest */}
      <path d="M60 108 Q58 100 55 98 L55 100 Q65 130 70 165 L130 165 Q135 130 145 100 L145 98 Q142 100 140 108 Q130 95 100 95 Q70 95 60 108 Z" fill="#6366f1" />

      {/* Pec definition lines */}
      <path d="M75 110 Q100 125 125 110" stroke="#4f46e5" strokeWidth="1.5" fill="none" />
      <path d="M80 112 Q90 120 100 118" stroke="#4f46e5" strokeWidth="1" fill="none" />
      <path d="M120 112 Q110 120 100 118" stroke="#4f46e5" strokeWidth="1" fill="none" />

      {/* Abs - 8-pack definition */}
      <line x1="100" y1="125" x2="100" y2="162" stroke="#4f46e5" strokeWidth="1.2" />
      <path d="M88 130 Q100 132 112 130" stroke="#4f46e5" strokeWidth="1" fill="none" />
      <path d="M86 140 Q100 142 114 140" stroke="#4f46e5" strokeWidth="1" fill="none" />
      <path d="M85 150 Q100 152 115 150" stroke="#4f46e5" strokeWidth="1" fill="none" />
      <path d="M86 160 Q100 162 114 160" stroke="#4f46e5" strokeWidth="1" fill="none" />

      {/* HUGE biceps - left */}
      <ellipse cx="38" cy="135" rx="16" ry="22" fill="#d4a88c" transform="rotate(-10 38 135)" />
      {/* Bicep vein */}
      <path d="M32 125 Q36 130 34 140 Q33 148 36 155" stroke="#c49478" strokeWidth="1.2" fill="none" />
      {/* Bicep peak */}
      <path d="M28 128 Q35 118 44 128" stroke="#c49478" strokeWidth="1" fill="none" />

      {/* HUGE biceps - right */}
      <ellipse cx="162" cy="135" rx="16" ry="22" fill="#d4a88c" transform="rotate(10 162 135)" />
      {/* Bicep vein */}
      <path d="M168 125 Q164 130 166 140 Q167 148 164 155" stroke="#c49478" strokeWidth="1.2" fill="none" />
      {/* Bicep peak */}
      <path d="M172 128 Q165 118 156 128" stroke="#c49478" strokeWidth="1" fill="none" />

      {/* Forearms - thick */}
      <ellipse cx="30" cy="168" rx="12" ry="20" fill="#d4a88c" transform="rotate(-5 30 168)" />
      <ellipse cx="170" cy="168" rx="12" ry="20" fill="#d4a88c" transform="rotate(5 170 168)" />
      {/* Forearm veins */}
      <path d="M26 160 Q30 170 28 180" stroke="#c49478" strokeWidth="1" fill="none" />
      <path d="M174 160 Q170 170 172 180" stroke="#c49478" strokeWidth="1" fill="none" />

      {/* Fists */}
      <circle cx="28" cy="192" r="9" fill="#d4a88c" />
      <circle cx="172" cy="192" r="9" fill="#d4a88c" />

      {/* Belt */}
      <rect x="68" y="163" width="64" height="8" rx="3" fill="#1e293b" />
      <rect x="95" y="163" width="10" height="8" rx="2" fill="#fbbf24" />

      {/* Legs - THICK quads */}
      <path d="M70 170 L65 220 Q68 230 80 230 L90 230 Q95 230 95 220 L100 170 Z" fill="#334155" />
      <path d="M130 170 L135 220 Q132 230 120 230 L110 230 Q105 230 105 220 L100 170 Z" fill="#334155" />
      {/* Quad definition */}
      <line x1="82" y1="175" x2="80" y2="220" stroke="#1e293b" strokeWidth="1" opacity="0.5" />
      <line x1="118" y1="175" x2="120" y2="220" stroke="#1e293b" strokeWidth="1" opacity="0.5" />

      {/* Boots */}
      <path d="M63 228 L60 248 Q60 255 70 255 L90 255 Q97 255 97 248 L95 228 Z" fill="#1e293b" />
      <path d="M103 228 L105 248 Q105 255 115 255 L135 255 Q142 255 142 248 L140 228 Z" fill="#1e293b" />
      {/* Boot soles */}
      <rect x="58" y="252" width="41" height="5" rx="2" fill="#0f172a" />
      <rect x="103" y="252" width="41" height="5" rx="2" fill="#0f172a" />

      {/* Bluetooth "B" symbol on chest */}
      <g transform="translate(92, 105)">
        <path d="M4 0 L12 0 Q16 0 16 4 L16 8 Q16 10 14 11 L8 14 L14 17 Q16 18 16 20 L16 24 Q16 28 12 28 L4 28 L4 0 Z M8 4 L8 12 L12 8 Q13 7 12 6 L8 4 Z M8 16 L8 24 L12 24 Q13 24 13 22 L13 20 L8 16 Z" fill="white" opacity="0.9" />
      </g>
    </svg>
  );
}
