/**
 * Shared SVG icon constants for use in HTML template strings.
 *
 * All icons use viewBox="0 0 24 24" and inherit surrounding text color via
 * currentColor where applicable. Colored icons use inline fill/stroke values.
 *
 * Note: when the same icon appears multiple times on a page, gradient <defs>
 * IDs are duplicated in the DOM — browsers use the first definition, which is
 * fine because all instances are visually identical.
 */

export const BAG_ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" style="vertical-align:-2px">',
  '<defs>',
  '<linearGradient id="bagG" x1="0" y1="0" x2="0" y2="1">',
  '<stop offset="0%" stop-color="#FFE55C"/>',
  '<stop offset="50%" stop-color="#FFC200"/>',
  '<stop offset="100%" stop-color="#B35A00"/>',
  '</linearGradient>',
  '</defs>',
  // Bag body — wide rounded teardrop
  '<path d="M4.5 16.5 C4.5 21 7.5 23 12 23 C16.5 23 19.5 21 19.5 16.5 C19.5 12 16.5 10 12 10 C7.5 10 4.5 12 4.5 16.5 Z" fill="url(#bagG)" stroke="#8B5E00" stroke-width="1"/>',
  // Neck — narrow band sitting above the body
  '<path d="M10.5 10 L10.5 8.5 Q10.5 7.5 12 7.5 Q13.5 7.5 13.5 8.5 L13.5 10" fill="#E6A800" stroke="#8B5E00" stroke-width="0.8"/>',
  // Cinch string tied around the neck
  '<line x1="10" y1="9" x2="14" y2="9" stroke="#6B4400" stroke-width="1.5" stroke-linecap="round"/>',
  // Knot — small arch above the cinch
  '<path d="M10.5 8.2 Q12 6 13.5 8.2" fill="none" stroke="#8B5E00" stroke-width="1.5" stroke-linecap="round"/>',
  // Dollar sign — vertical bar
  '<line x1="12" y1="11.5" x2="12" y2="21.5" stroke="#6B4400" stroke-width="1.5" stroke-linecap="round"/>',
  // Dollar sign — S curve
  '<path d="M14.5 13.8 Q14.5 11.5 12 11.5 Q9.5 11.5 9.5 13.8 Q9.5 16 12 16 Q14.5 16 14.5 18.2 Q14.5 20.5 12 20.5 Q9.5 20.5 9.5 18.2" fill="none" stroke="#6B4400" stroke-width="1.4" stroke-linecap="round"/>',
  '</svg>',
].join('')

export const DUNCE_CAP_ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" style="vertical-align:-2px">',
  // Hat body — red cone
  '<path d="M12 2 L3 20 L21 20 Z" fill="#CC2200" stroke="#991100" stroke-width="0.8"/>',
  // Brim — yellow band
  '<ellipse cx="12" cy="20" rx="9" ry="2" fill="#FFD700" stroke="#CC9900" stroke-width="0.8"/>',
  // Pompom — yellow circle at tip
  '<circle cx="12" cy="3" r="1.8" fill="#FFD700" stroke="#CC9900" stroke-width="0.6"/>',
  '</svg>',
].join('')

export const EMBARRASSED_FACE_ICON = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" style="vertical-align:-2px">',
  // Face
  '<circle cx="12" cy="12" r="10" fill="#FFD700" stroke="#CC9900" stroke-width="1"/>',
  // Left eye — X
  '<line x1="7" y1="8" x2="10" y2="11" stroke="#333" stroke-width="1.5" stroke-linecap="round"/>',
  '<line x1="10" y1="8" x2="7" y2="11" stroke="#333" stroke-width="1.5" stroke-linecap="round"/>',
  // Right eye — X
  '<line x1="14" y1="8" x2="17" y2="11" stroke="#333" stroke-width="1.5" stroke-linecap="round"/>',
  '<line x1="17" y1="8" x2="14" y2="11" stroke="#333" stroke-width="1.5" stroke-linecap="round"/>',
  // Left blush
  '<ellipse cx="7.5" cy="14.5" rx="2.5" ry="1.5" fill="#FF8080" opacity="0.7"/>',
  // Right blush
  '<ellipse cx="16.5" cy="14.5" rx="2.5" ry="1.5" fill="#FF8080" opacity="0.7"/>',
  // Worried mouth
  '<path d="M9 18 Q12 16 15 18" fill="none" stroke="#333" stroke-width="1.5" stroke-linecap="round"/>',
  '</svg>',
].join('')
