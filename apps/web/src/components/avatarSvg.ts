/**
 * Single source of truth for avatar SVG generation.
 * Used by UserAvatar (React component) and miniAvatarCache (canvas).
 */

function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function bits(hash: number, offset: number, count: number): number {
  return (hash >>> offset) & ((1 << count) - 1);
}

export function featureLevel(eventCount: number | undefined): number {
  if (eventCount === undefined) return 4;
  if (eventCount < 5) return 0;
  if (eventCount < 10) return 1;
  if (eventCount < 15) return 2;
  if (eventCount < 20) return 3;
  return 4;
}

const HUES = [
  0, 8, 18, 30, 42, 55, 70, 90, 110, 130, 150, 170,
  185, 200, 215, 230, 248, 265, 280, 295, 310, 325, 340, 355,
];

// Clothing color combos inspired by real fashion pairings: [primary, highlight]
const CLOTHING_COMBOS: [string, string][] = [
  // Reds
  ["#C0392B", "#ECF0F1"],  // red + white
  ["#C0392B", "#1A1A1A"],  // red + black
  ["#C0392B", "#2C3E50"],  // red + navy
  ["#C0392B", "#BDC3C7"],  // red + grey
  ["#8B1A1A", "#D4A76A"],  // dark red + tan
  ["#8B1A1A", "#F5CBA7"],  // dark red + peach
  // Blues
  ["#2E86C1", "#ECF0F1"],  // blue + white
  ["#2E86C1", "#1A1A1A"],  // blue + black
  ["#2E86C1", "#F39C12"],  // blue + gold
  ["#2E86C1", "#E74C3C"],  // blue + red
  ["#1B4F72", "#2ECC71"],  // navy + green
  ["#1B4F72", "#BDC3C7"],  // navy + grey
  ["#1B4F72", "#D4A76A"],  // navy + tan
  ["#AED6F1", "#C0392B"],  // light blue + red
  ["#AED6F1", "#1A1A1A"],  // light blue + black
  // Greens
  ["#27AE60", "#ECF0F1"],  // green + white
  ["#27AE60", "#1A1A1A"],  // green + black
  ["#27AE60", "#D4A76A"],  // green + tan
  ["#1E8449", "#F5CBA7"],  // dark green + peach
  ["#1E8449", "#BDC3C7"],  // dark green + grey
  ["#1E8449", "#C0392B"],  // dark green + red
  // Oranges
  ["#E67E22", "#ECF0F1"],  // orange + white
  ["#E67E22", "#1A1A1A"],  // orange + black
  ["#E67E22", "#2C3E50"],  // orange + navy
  ["#E67E22", "#BDC3C7"],  // orange + grey
  ["#D35400", "#1B4F72"],  // dark orange + navy
  ["#F5CBA7", "#8B1A1A"],  // peach + dark red
  ["#F5CBA7", "#D4A76A"],  // peach + tan
  // Yellows
  ["#F1C40F", "#1A1A1A"],  // yellow + black
  ["#F1C40F", "#2C3E50"],  // yellow + navy
  ["#F1C40F", "#D4A76A"],  // yellow + tan
  ["#D4AC0D", "#1A1A1A"],  // dark yellow + black
  ["#D4AC0D", "#8B4513"],  // dark yellow + brown
  // Purples & Pinks
  ["#8E44AD", "#ECF0F1"],  // purple + white
  ["#8E44AD", "#1A1A1A"],  // purple + black
  ["#E91E8C", "#1A1A1A"],  // pink + black
  ["#E91E8C", "#ECF0F1"],  // pink + white
  // Neutrals
  ["#566573", "#ECF0F1"],  // charcoal + white
  ["#1A1A1A", "#C0392B"],  // black + red
  ["#1A1A1A", "#2E86C1"],  // black + blue
  ["#D4A76A", "#1B4F72"],  // tan + navy
  ["#8B4513", "#F1C40F"],  // brown + yellow
  ["#8B4513", "#27AE60"],  // brown + green
  // Teal & Olive
  ["#16A085", "#ECF0F1"],  // teal + white
  ["#16A085", "#D4A76A"],  // teal + tan
  ["#6B8E23", "#D4A76A"],  // olive + tan
  ["#6B8E23", "#8B1A1A"],  // olive + dark red
];

const EYE_DIMS: [number, number, number][] = [
  [7, 6, 3.5],
  [8, 9, 4.5],
  [8, 4, 3],
  [7, 7, 5],
];

export function buildAvatarSvg(distinctId: string, countryCode?: string, eventCount?: number): string {
  const h = djb2(distinctId);
  const h2 = djb2(distinctId + "salt");
  const h3 = djb2(distinctId + "pepper");
  const h4 = djb2(distinctId + "cumin");

  const hueIdx = bits(h, 0, 5) % HUES.length;
  const faceShape = bits(h, 4, 1);
  const eyeStyle = bits(h, 5, 2);
  const eyeSpacing = bits(h, 7, 1);
  const mouthStyle = bits(h, 8, 2);
  const earStyle = bits(h, 10, 2);
  const hasBlush = bits(h, 12, 1);

  const bodyTone = bits(h2, 0, 1);
  const hatStyle = bits(h2, 1, 3);
  const hairStyle = bits(h2, 4, 2);
  const browStyle = bits(h2, 6, 2);

  const facialHair = bits(h3, 0, 3);
  const noseStyle = bits(h3, 3, 1);
  const glassesStyle = bits(h3, 4, 2);
  const mouthExpr = bits(h3, 6, 2);

  const cheekStyle = bits(h4, 0, 2);
  const accessory = bits(h4, 2, 2);

  // ── Colors ──
  const level = featureLevel(eventCount);
  const showFacialHair = level >= 1;
  const showGlasses = level >= 2;
  const showAccessories = level >= 2;
  const showMouthExtras = level >= 3;
  const showHats = level >= 4;

  const sat = 30 + level * 10;         // 30 → 70
  const satStrong = 40 + level * 8;    // 40 → 72

  const hue = HUES[hueIdx];
  const bgLight = bodyTone ? 45 : 60;
  const bgColor = `hsl(${hue}, ${sat}%, ${bgLight}%)`;
  const darkColor = `hsl(${hue}, ${satStrong}%, ${Math.max(bgLight - 25, 18)}%)`;
  const lightColor = `hsl(${hue}, ${sat - 10}%, ${Math.min(bgLight + 20, 85)}%)`;
  const hatHue = HUES[(hueIdx + 6) % HUES.length];
  const hatColor = `hsl(${hatHue}, ${satStrong}%, 40%)`;
  const hatDark = `hsl(${hatHue}, ${satStrong + 5}%, 28%)`;
  const hairColor = `hsl(${hue}, ${Math.max(sat - 20, 15)}%, ${bodyTone ? 25 : 35}%)`;
  const glassesColor = glassesStyle === 3 ? `hsl(${hue}, 20%, 15%)` : `hsl(${hue}, 10%, 30%)`;
  const clothingIdx = bits(h4, 4, 6) % CLOTHING_COMBOS.length;
  const clothingColor = CLOTHING_COMBOS[clothingIdx][0];
  const clothingHighlight = CLOTHING_COMBOS[clothingIdx][1];
  const irisHue = HUES[(hueIdx + 4) % HUES.length];
  const irisColor = `hsl(${irisHue}, ${satStrong + 10}%, 45%)`;
  const isFR = countryCode?.toUpperCase() === "FR";

  const cx = 50;
  const faceCy = 45;
  const faceRx = faceShape === 0 ? 34 : 30;
  const faceRy = faceShape === 0 ? 38 : 42;
  const eyeY = 38;
  const mouthY = 60;
  const eyeGap = eyeSpacing ? 16 : 12;
  const [scRx, scRy, irR] = EYE_DIMS[eyeStyle];
  const hasHat = showHats && hatStyle >= 4;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 130">`;

  // ── Shoulders ──
  if (isFR) {
    s += `<ellipse cx="50" cy="118" rx="46" ry="22" fill="#fff"/>`;
    for (const dy of [-14, -7, 0, 7, 14]) {
      s += `<ellipse cx="50" cy="${118 + dy}" rx="44" ry="3" fill="#1a2a5e"/>`;
    }
    s += `<path d="M28,90 Q50,86 72,90 Q72,98 50,100 Q28,98 28,90" fill="#cc1111"/>`;
    s += `<path d="M36,96 L42,118 L50,100" fill="#cc1111"/>`;
    s += `<path d="M64,96 L58,118 L50,100" fill="#aa0e0e"/>`;
    s += `<ellipse cx="50" cy="98" rx="6" ry="4" fill="#dd1515"/>`;
    s += `<path d="M42,118 Q40,124 38,126" fill="none" stroke="#cc1111" stroke-width="4" stroke-linecap="round"/>`;
    s += `<path d="M58,118 Q60,124 62,126" fill="none" stroke="#aa0e0e" stroke-width="4" stroke-linecap="round"/>`;
  } else {
    s += `<ellipse cx="50" cy="118" rx="46" ry="22" fill="${clothingColor}"/>`;
    s += `<path d="M34,105 Q50,112 66,105" fill="none" stroke="${clothingHighlight}" stroke-width="2"/>`;
  }

  // ── Neck ──
  s += `<rect x="40" y="78" width="20" height="20" rx="4" fill="${bgColor}"/>`;

  // ── Ears ──
  if (earStyle === 1) {
    s += `<circle cx="18" cy="26" r="14" fill="${darkColor}"/>`;
    s += `<circle cx="82" cy="26" r="14" fill="${darkColor}"/>`;
  } else if (earStyle === 2) {
    s += `<polygon points="10,38 22,6 34,34" fill="${darkColor}"/>`;
    s += `<polygon points="90,38 78,6 66,34" fill="${darkColor}"/>`;
  } else if (earStyle === 3) {
    s += `<polygon points="24,20 30,-2 36,20" fill="${darkColor}"/>`;
    s += `<polygon points="64,20 70,-2 76,20" fill="${darkColor}"/>`;
  }

  // ── Hair behind face (only if no hat) ──
  if (!hasHat && !isFR) {
    if (hairStyle === 1) {
      s += `<polygon points="30,16 35,-2 40,14" fill="${hairColor}"/>`;
      s += `<polygon points="42,14 48,-4 54,12" fill="${hairColor}"/>`;
      s += `<polygon points="55,13 60,-3 66,15" fill="${hairColor}"/>`;
      s += `<polygon points="65,16 70,1 74,18" fill="${hairColor}"/>`;
    } else if (hairStyle === 2) {
      s += `<ellipse cx="35" cy="12" rx="24" ry="12" fill="${hairColor}"/>`;
    } else if (hairStyle === 3) {
      s += `<circle cx="28" cy="14" r="10" fill="${hairColor}"/>`;
      s += `<circle cx="42" cy="8" r="10" fill="${hairColor}"/>`;
      s += `<circle cx="58" cy="8" r="10" fill="${hairColor}"/>`;
      s += `<circle cx="72" cy="14" r="10" fill="${hairColor}"/>`;
    }
  }

  // ── Face ──
  s += `<ellipse cx="${cx}" cy="${faceCy}" rx="${faceRx}" ry="${faceRy}" fill="${bgColor}"/>`;
  s += `<ellipse cx="${cx}" cy="${faceCy + faceRy - 4}" rx="${faceRx * 0.6}" ry="6" fill="${darkColor}" opacity="0.08"/>`;

  // ── Brows ──
  if (browStyle === 1) {
    s += `<line x1="${cx - eyeGap - 5}" y1="${eyeY - 10}" x2="${cx - eyeGap + 5}" y2="${eyeY - 10}" stroke="${darkColor}" stroke-width="2" stroke-linecap="round"/>`;
    s += `<line x1="${cx + eyeGap - 5}" y1="${eyeY - 10}" x2="${cx + eyeGap + 5}" y2="${eyeY - 10}" stroke="${darkColor}" stroke-width="2" stroke-linecap="round"/>`;
  } else if (browStyle === 2) {
    s += `<line x1="${cx - eyeGap - 6}" y1="${eyeY - 10}" x2="${cx - eyeGap + 6}" y2="${eyeY - 10}" stroke="${darkColor}" stroke-width="3.5" stroke-linecap="round"/>`;
    s += `<line x1="${cx + eyeGap - 6}" y1="${eyeY - 10}" x2="${cx + eyeGap + 6}" y2="${eyeY - 10}" stroke="${darkColor}" stroke-width="3.5" stroke-linecap="round"/>`;
  } else if (browStyle === 3) {
    s += `<line x1="${cx - eyeGap - 6}" y1="${eyeY - 8}" x2="${cx - eyeGap + 5}" y2="${eyeY - 12}" stroke="${darkColor}" stroke-width="2.5" stroke-linecap="round"/>`;
    s += `<line x1="${cx + eyeGap + 6}" y1="${eyeY - 8}" x2="${cx + eyeGap - 5}" y2="${eyeY - 12}" stroke="${darkColor}" stroke-width="2.5" stroke-linecap="round"/>`;
  }

  // ── Eyes ──
  s += `<ellipse cx="${cx - eyeGap}" cy="${eyeY}" rx="${scRx}" ry="${scRy}" fill="#fff"/>`;
  s += `<ellipse cx="${cx + eyeGap}" cy="${eyeY}" rx="${scRx}" ry="${scRy}" fill="#fff"/>`;
  s += `<circle cx="${cx - eyeGap + 1}" cy="${eyeY + 0.5}" r="${irR}" fill="${irisColor}"/>`;
  s += `<circle cx="${cx + eyeGap + 1}" cy="${eyeY + 0.5}" r="${irR}" fill="${irisColor}"/>`;
  s += `<circle cx="${cx - eyeGap + 1}" cy="${eyeY + 0.5}" r="${irR * 0.5}" fill="#1a1a1a"/>`;
  s += `<circle cx="${cx + eyeGap + 1}" cy="${eyeY + 0.5}" r="${irR * 0.5}" fill="#1a1a1a"/>`;
  s += `<circle cx="${cx - eyeGap - 0.5}" cy="${eyeY - 1.5}" r="1.8" fill="#fff"/>`;
  s += `<circle cx="${cx + eyeGap - 0.5}" cy="${eyeY - 1.5}" r="1.8" fill="#fff"/>`;

  // ── Nose ──
  if (noseStyle === 0) {
    s += `<circle cx="${cx}" cy="${eyeY + 13}" r="2.5" fill="${lightColor}" opacity="0.6"/>`;
  } else {
    s += `<polygon points="${cx},${eyeY + 8} ${cx - 4},${eyeY + 15} ${cx + 4},${eyeY + 15}" fill="${lightColor}" opacity="0.5"/>`;
  }

  // ── Blush ──
  if (hasBlush) {
    s += `<ellipse cx="${cx - eyeGap - 6}" cy="${eyeY + 10}" rx="6" ry="4" fill="rgba(255,130,150,0.4)"/>`;
    s += `<ellipse cx="${cx + eyeGap + 6}" cy="${eyeY + 10}" rx="6" ry="4" fill="rgba(255,130,150,0.4)"/>`;
  }

  // ── Glasses ──
  if (showGlasses && glassesStyle === 1) {
    s += `<circle cx="${cx - eyeGap}" cy="${eyeY}" r="10" fill="none" stroke="${glassesColor}" stroke-width="2"/>`;
    s += `<circle cx="${cx + eyeGap}" cy="${eyeY}" r="10" fill="none" stroke="${glassesColor}" stroke-width="2"/>`;
    s += `<line x1="${cx - eyeGap + 10}" y1="${eyeY}" x2="${cx + eyeGap - 10}" y2="${eyeY}" stroke="${glassesColor}" stroke-width="1.5"/>`;
    s += `<line x1="${cx - eyeGap - 10}" y1="${eyeY}" x2="${cx - eyeGap - 16}" y2="${eyeY - 3}" stroke="${glassesColor}" stroke-width="1.5" stroke-linecap="round"/>`;
    s += `<line x1="${cx + eyeGap + 10}" y1="${eyeY}" x2="${cx + eyeGap + 16}" y2="${eyeY - 3}" stroke="${glassesColor}" stroke-width="1.5" stroke-linecap="round"/>`;
  } else if (showGlasses && glassesStyle === 2) {
    s += `<rect x="${cx - eyeGap - 10}" y="${eyeY - 7}" width="20" height="14" rx="3" fill="none" stroke="${glassesColor}" stroke-width="2"/>`;
    s += `<rect x="${cx + eyeGap - 10}" y="${eyeY - 7}" width="20" height="14" rx="3" fill="none" stroke="${glassesColor}" stroke-width="2"/>`;
    s += `<line x1="${cx - eyeGap + 10}" y1="${eyeY}" x2="${cx + eyeGap - 10}" y2="${eyeY}" stroke="${glassesColor}" stroke-width="1.5"/>`;
    s += `<line x1="${cx - eyeGap - 10}" y1="${eyeY}" x2="${cx - eyeGap - 16}" y2="${eyeY - 3}" stroke="${glassesColor}" stroke-width="1.5" stroke-linecap="round"/>`;
    s += `<line x1="${cx + eyeGap + 10}" y1="${eyeY}" x2="${cx + eyeGap + 16}" y2="${eyeY - 3}" stroke="${glassesColor}" stroke-width="1.5" stroke-linecap="round"/>`;
  } else if (showGlasses && glassesStyle === 3) {
    s += `<path d="M${cx - eyeGap - 12},${eyeY - 6} Q${cx - eyeGap},${eyeY - 10} ${cx - eyeGap + 12},${eyeY - 6} L${cx - eyeGap + 12},${eyeY + 5} Q${cx - eyeGap},${eyeY + 9} ${cx - eyeGap - 12},${eyeY + 5} Z" fill="${glassesColor}" opacity="0.85"/>`;
    s += `<path d="M${cx + eyeGap - 12},${eyeY - 6} Q${cx + eyeGap},${eyeY - 10} ${cx + eyeGap + 12},${eyeY - 6} L${cx + eyeGap + 12},${eyeY + 5} Q${cx + eyeGap},${eyeY + 9} ${cx + eyeGap - 12},${eyeY + 5} Z" fill="${glassesColor}" opacity="0.85"/>`;
    s += `<ellipse cx="${cx - eyeGap + 4}" cy="${eyeY - 3}" rx="4" ry="2" fill="rgba(255,255,255,0.25)"/>`;
    s += `<ellipse cx="${cx + eyeGap + 4}" cy="${eyeY - 3}" rx="4" ry="2" fill="rgba(255,255,255,0.25)"/>`;
    s += `<line x1="${cx - eyeGap + 12}" y1="${eyeY - 2}" x2="${cx + eyeGap - 12}" y2="${eyeY - 2}" stroke="${glassesColor}" stroke-width="2.5"/>`;
    s += `<line x1="${cx - eyeGap - 12}" y1="${eyeY - 2}" x2="${cx - eyeGap - 18}" y2="${eyeY - 6}" stroke="${glassesColor}" stroke-width="2" stroke-linecap="round"/>`;
    s += `<line x1="${cx + eyeGap + 12}" y1="${eyeY - 2}" x2="${cx + eyeGap + 18}" y2="${eyeY - 6}" stroke="${glassesColor}" stroke-width="2" stroke-linecap="round"/>`;
  }

  // ── Mouth (all smiling) ──
  if (mouthStyle === 0) {
    s += `<path d="M${cx - 12},${mouthY} Q${cx},${mouthY + 14} ${cx + 12},${mouthY}" fill="none" stroke="${darkColor}" stroke-width="3" stroke-linecap="round"/>`;
    if (showMouthExtras && mouthExpr === 1) {
      s += `<path d="M${cx - 8},${mouthY + 2} Q${cx},${mouthY + 10} ${cx + 8},${mouthY + 2}" fill="#fff"/>`;
    }
    if (showMouthExtras && mouthExpr === 2) {
      s += `<ellipse cx="${cx}" cy="${mouthY + 10}" rx="5" ry="4" fill="#E85A6B"/>`;
    }
  } else if (mouthStyle === 1) {
    s += `<path d="M${cx - 10},${mouthY + 2} Q${cx},${mouthY + 10} ${cx + 10},${mouthY + 2}" fill="none" stroke="${darkColor}" stroke-width="3" stroke-linecap="round"/>`;
    if (showMouthExtras && mouthExpr === 1) {
      s += `<path d="M${cx - 7},${mouthY + 3} Q${cx},${mouthY + 8} ${cx + 7},${mouthY + 3}" fill="#fff"/>`;
    }
    if (showMouthExtras && mouthExpr === 2) {
      s += `<ellipse cx="${cx}" cy="${mouthY + 8}" rx="4" ry="3" fill="#E85A6B"/>`;
    }
  } else if (mouthStyle === 2) {
    s += `<path d="M${cx - 10},${mouthY} L${cx + 10},${mouthY} Q${cx + 10},${mouthY + 14} ${cx},${mouthY + 14} Q${cx - 10},${mouthY + 14} ${cx - 10},${mouthY}" fill="${darkColor}"/>`;
    s += `<rect x="${cx - 9}" y="${mouthY}" width="18" height="4" rx="1" fill="#fff"/>`;
    if (showMouthExtras && mouthExpr === 2) {
      s += `<ellipse cx="${cx}" cy="${mouthY + 11}" rx="5" ry="4" fill="#E85A6B"/>`;
    }
  } else {
    s += `<path d="M${cx - 8},${mouthY + 4} Q${cx + 2},${mouthY + 12} ${cx + 12},${mouthY}" fill="none" stroke="${darkColor}" stroke-width="3" stroke-linecap="round"/>`;
    if (showMouthExtras && mouthExpr === 2) {
      s += `<ellipse cx="${cx + 8}" cy="${mouthY + 8}" rx="4" ry="3" fill="#E85A6B"/>`;
    }
  }

  // ── Cheek details ──
  if (cheekStyle === 1) {
    for (const [dx, dy] of [[-8, 6], [-4, 8], [-6, 10], [4, 6], [8, 8], [6, 10]]) {
      s += `<circle cx="${cx + dx + (dx > 0 ? eyeGap : -eyeGap)}" cy="${eyeY + dy}" r="1.2" fill="${darkColor}" opacity="0.4"/>`;
    }
  } else if (cheekStyle === 2) {
    s += `<path d="M${cx - eyeGap - 2},${eyeY + 4} L${cx - eyeGap + 4},${eyeY + 12} L${cx - eyeGap},${eyeY + 10}" fill="none" stroke="${darkColor}" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>`;
  } else if (cheekStyle === 3) {
    s += `<circle cx="${cx + eyeGap + 6}" cy="${mouthY - 4}" r="2" fill="${darkColor}"/>`;
  }

  // ── Accessories ──
  if (showAccessories && accessory === 1) {
    s += `<g transform="translate(${cx + 8},${eyeY - 18}) rotate(15)">`;
    s += `<rect x="-8" y="-3" width="16" height="6" rx="1" fill="#F5D0A9"/>`;
    s += `<rect x="-3" y="-3" width="6" height="6" rx="0.5" fill="#E8BA8A"/>`;
    s += `</g>`;
  } else if (showAccessories && accessory === 2) {
    s += `<circle cx="${cx - (faceRx - 2)}" cy="${eyeY + 6}" r="3" fill="none" stroke="gold" stroke-width="1.5"/>`;
  } else if (showAccessories && accessory === 3 && !showGlasses) {
    s += `<circle cx="${cx + eyeGap}" cy="${eyeY}" r="10" fill="none" stroke="gold" stroke-width="1.5"/>`;
    s += `<line x1="${cx + eyeGap}" y1="${eyeY + 10}" x2="${cx + eyeGap - 4}" y2="${mouthY + 16}" stroke="gold" stroke-width="1"/>`;
  }

  // ── Facial hair ──
  if (showFacialHair && facialHair === 4) {
    s += `<path d="M${cx - 12},${mouthY - 2} Q${cx - 6},${mouthY + 5} ${cx},${mouthY - 1} Q${cx + 6},${mouthY + 5} ${cx + 12},${mouthY - 2}" fill="${hairColor}"/>`;
  } else if (showFacialHair && facialHair === 5) {
    s += `<ellipse cx="${cx}" cy="${mouthY + 12}" rx="8" ry="10" fill="${hairColor}"/>`;
  } else if (showFacialHair && facialHair === 6) {
    s += `<path d="M${cx - 22},${mouthY - 4} Q${cx - 20},${mouthY + 22} ${cx},${mouthY + 28} Q${cx + 20},${mouthY + 22} ${cx + 22},${mouthY - 4}" fill="${hairColor}"/>`;
    if (mouthStyle === 0) {
      s += `<path d="M${cx - 10},${mouthY} Q${cx},${mouthY + 12} ${cx + 10},${mouthY}" fill="none" stroke="${darkColor}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
    if (mouthStyle === 1) {
      s += `<line x1="${cx - 8}" y1="${mouthY + 2}" x2="${cx + 8}" y2="${mouthY + 2}" stroke="${darkColor}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
  } else if (showFacialHair && facialHair === 7) {
    for (const [dx, dy] of [[-10, 2], [-6, 5], [-2, 3], [2, 6], [6, 4], [10, 2], [-8, 8], [0, 9], [8, 8], [-4, 11], [4, 11]]) {
      s += `<circle cx="${cx + dx}" cy="${mouthY + dy}" r="1.2" fill="${hairColor}" opacity="0.6"/>`;
    }
  }

  // French always get a mustache
  if (isFR) {
    s += `<path d="M${cx - 14},${mouthY - 3} Q${cx - 7},${mouthY + 6} ${cx},${mouthY - 2} Q${cx + 7},${mouthY + 6} ${cx + 14},${mouthY - 3}" fill="#1a1a1a"/>`;
  }

  // ── Hats ──
  if (showHats && !isFR && hatStyle === 4) {
    s += `<ellipse cx="${cx}" cy="16" rx="32" ry="18" fill="${hatColor}"/>`;
    s += `<rect x="18" y="14" width="64" height="8" rx="4" fill="${hatDark}"/>`;
    s += `<circle cx="${cx}" cy="1" r="4" fill="${hatColor}"/>`;
  } else if (showHats && !isFR && hatStyle === 5) {
    s += `<rect x="28" y="-6" width="44" height="28" rx="4" fill="${hatColor}"/>`;
    s += `<rect x="18" y="20" width="64" height="6" rx="3" fill="${hatDark}"/>`;
  } else if (showHats && !isFR && hatStyle === 6) {
    s += `<ellipse cx="${cx}" cy="18" rx="34" ry="16" fill="${hatColor}"/>`;
    s += `<ellipse cx="${cx + 28}" cy="20" rx="16" ry="6" fill="${hatDark}"/>`;
  } else if (showHats && !isFR && hatStyle === 7) {
    s += `<polygon points="${cx},${-8} ${cx - 22},24 ${cx + 22},24" fill="${hatColor}"/>`;
    s += `<circle cx="${cx}" cy="-8" r="4" fill="gold"/>`;
    s += `<line x1="${cx - 8}" y1="8" x2="${cx + 8}" y2="8" stroke="${hatDark}" stroke-width="2"/>`;
    s += `<line x1="${cx - 14}" y1="16" x2="${cx + 14}" y2="16" stroke="${hatDark}" stroke-width="2"/>`;
  }

  // French beret (always)
  if (isFR) {
    s += `<ellipse cx="${cx + 4}" cy="14" rx="36" ry="12" fill="#1a1a1a"/>`;
    s += `<ellipse cx="${cx + 10}" cy="8" rx="22" ry="10" fill="#222"/>`;
    s += `<circle cx="${cx + 10}" cy="2" r="3" fill="#1a1a1a"/>`;
    s += `<ellipse cx="${cx}" cy="18" rx="34" ry="5" fill="#111"/>`;
  }

  // French baguette + wine
  if (isFR) {
    s += `<path d="M${cx + 34},108 Q${cx + 42},90 ${cx + 36},${eyeY + 6}" fill="none" stroke="${bgColor}" stroke-width="6" stroke-linecap="round"/>`;
    s += `<circle cx="${cx + 36}" cy="${eyeY + 4}" r="5" fill="${bgColor}"/>`;
    s += `<g transform="translate(${cx + 36},${eyeY + 4}) rotate(-25)">`;
    s += `<ellipse cx="0" cy="0" rx="7" ry="42" fill="#D4A843"/>`;
    s += `<ellipse cx="0" cy="0" rx="5" ry="38" fill="#E2BC5D"/>`;
    for (const dy of [-24, -14, -4, 6, 16, 26]) {
      s += `<line x1="-3" y1="${dy}" x2="3" y2="${dy + 2}" stroke="#C4923A" stroke-width="1" stroke-linecap="round"/>`;
    }
    s += `</g>`;

    s += `<path d="M${cx - 34},108 Q${cx - 42},90 ${cx - 34},${eyeY + 10}" fill="none" stroke="${bgColor}" stroke-width="6" stroke-linecap="round"/>`;
    s += `<circle cx="${cx - 34}" cy="${eyeY + 8}" r="5" fill="${bgColor}"/>`;
    s += `<g transform="translate(${cx - 34},${eyeY + 8})">`;
    s += `<ellipse cx="0" cy="-12" rx="10" ry="13" fill="none" stroke="#ddd" stroke-width="1.5"/>`;
    s += `<defs><clipPath id="wc"><ellipse cx="0" cy="-12" rx="9" ry="12"/></clipPath></defs>`;
    s += `<rect x="-9" y="-14" width="18" height="12" fill="#6B1126" clip-path="url(#wc)"/>`;
    s += `<ellipse cx="-3" cy="-10" rx="3" ry="1.5" fill="rgba(255,255,255,0.15)"/>`;
    s += `<line x1="0" y1="1" x2="0" y2="12" stroke="#ddd" stroke-width="1.5"/>`;
    s += `<ellipse cx="0" cy="12" rx="7" ry="2" fill="#ddd"/>`;
    s += `</g>`;
  }

  s += `</svg>`;
  return s;
}
