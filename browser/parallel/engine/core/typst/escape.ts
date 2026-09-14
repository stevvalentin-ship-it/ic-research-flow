const SUBSCRIPT = new Map(Object.entries({
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k',
  'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o', 'ₚ': 'p', 'ᵣ': 'r',
  'ₛ': 's', 'ₜ': 't', 'ₓ': 'x',
}));

const SUPERSCRIPT = new Map(Object.entries({
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
  'ᵃ': 'a', 'ᵇ': 'b', 'ᶜ': 'c', 'ᵈ': 'd', 'ᵉ': 'e', 'ᶠ': 'f',
  'ᵍ': 'g', 'ʰ': 'h', 'ⁱ': 'i', 'ʲ': 'j', 'ᵏ': 'k', 'ˡ': 'l',
  'ᵐ': 'm', 'ⁿ': 'n', 'ᵒ': 'o', 'ᵖ': 'p', 'ʳ': 'r', 'ˢ': 's',
  'ᵗ': 't', 'ᵘ': 'u', 'ᵛ': 'v', 'ʷ': 'w', 'ˣ': 'x', 'ʸ': 'y', 'ᶻ': 'z',
}));

function escapePlainTypstText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([#$[\]<>@*_`/])/g, '\\$1');
}

export function escapeTypstText(text: string): string {
  const output: string[] = [];
  let plain = '';
  const flushPlain = (): void => {
    if (!plain) return;
    output.push(escapePlainTypstText(plain));
    plain = '';
  };
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    const map = SUBSCRIPT.has(character) ? SUBSCRIPT : SUPERSCRIPT.has(character) ? SUPERSCRIPT : undefined;
    if (!map) {
      plain += character;
      index += 1;
      continue;
    }
    flushPlain();
    let normalized = '';
    while (index < text.length && map.has(text[index]!)) {
      normalized += map.get(text[index]!)!;
      index += 1;
    }
    output.push(`#${map === SUBSCRIPT ? 'sub' : 'super'}[${escapePlainTypstText(normalized)}]`);
  }
  flushPlain();
  return output.join('');
}

export function escapeTypstString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
