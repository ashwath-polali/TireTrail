// Pixel icons as tiny SVGs, drawn on a whole-pixel grid and scaled by whole numbers.
const svg = (w: number, h: number, body: string, s = 3) =>
  `<svg viewBox="0 0 ${w} ${h}" width="${w * s}" height="${h * s}" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;

export const ICON = {
  drop: (s = 3) => svg(7, 8, '<path d="M3 0h1v1h1v1h1v1h1v3H6v1H5v1H2V7H1V6H0V3h1V2h1V1h1z" fill="#1d3b48"/><path d="M3 1h1v1h1v1h1v3H5v1H2V6H1V3h1V2h1z" fill="#5ec6ee"/><path d="M2 3h1v2H2z" fill="#e6f7fc"/>', s),
  grate: (s = 3) => svg(9, 7, '<path d="M0 0h9v7H0z" fill="#16191b"/><path d="M1 1h7v5H1z" fill="#3c4247"/><path d="M2 1h1v5H2zM4 1h1v5H4zM6 1h1v5H6z" fill="#8d959b"/>', s),
  pipe: (s = 3) => svg(8, 9, '<path d="M0 1h8v8H4V5H0z" fill="#2a221d"/><path d="M0 2h7v6H5V4H0z" fill="#d9d3c5"/><path d="M0 3h7v5H6V4H0z" fill="#5ec6ee"/>', s),
  pond: (s = 3) => svg(10, 7, '<path d="M2 1h6v1h1v1h1v2H9v1H8v1H2V6H1V5H0V3h1V2h1z" fill="#2a3d2a"/><path d="M2 2h6v1h1v2H8v1H2V5H1V3h1z" fill="#356070"/><path d="M3 3h2v1H3z" fill="#9cc4cf"/><path d="M1 0h1v2H1zM8 0h1v2H8z" fill="#79a85f"/>', s),
  fish: () => '<img class="spr" src="sprites/salmon2.png" width="32" height="32" alt="">',
  car: (s = 2) => svg(11, 8, '<path d="M2 1h7v1h1v2h1v3H9v1H7V7H4v1H2V7H0V4h1V2h1z" fill="currentColor"/><path d="M3 2h5v2H3z" fill="#0e1311"/>', s),
  map: (s = 2) => svg(10, 9, '<path d="M0 1h3v1h1V1h3v1h1V1h2v8H7V8H6v1H3V8H2v1H0z" fill="currentColor"/><path d="M3 2h1v6H3zM6 1h1v6H6z" fill="#0e1311"/>', s),
  list: (s = 2) => svg(10, 9, '<path d="M0 0h2v2H0zM3 0h7v2H3zM0 3h2v2H0zM3 3h7v2H3zM0 6h2v2H0zM3 6h7v2H3z" fill="currentColor"/>', s),
  brake: (s = 2) => svg(9, 9, '<path d="M3 0h3v1h1v1h1v1h1v3H8v1H7v1H6v1H3V8H2V7H1V6H0V3h1V2h1V1h1z" fill="#d9483b"/><path d="M2 4h5v1H2z" fill="#f4f1e6"/>', s),
  turn: (s = 2) => svg(9, 9, '<path d="M1 8V3h1V2h1V1h3V0h1v1h1v1h1v1H8v1H7v1H6V4H3v1H2v3z" fill="#8fd69a"/>', s),
  gauge: (s = 2) => svg(9, 8, '<path d="M2 1h5v1h1v1h1v4H0V3h1V2h1z" fill="#5ec6ee"/><path d="M2 3h1v1H2zM4 2h1v1H4zM6 3h1v1H6z" fill="#0e1311"/><path d="M4 4h1v2H4z" fill="#f4f1e6"/>', s),
  x: (s = 3) => svg(5, 5, '<path d="M0 0h1v1h1v1h1V1h1V0h1v1H4v1H3v1h1v1h1v1H4V4H3V3H2v1H1v1H0V4h1V3h1V2H1V1H0z" fill="#d9483b"/>', s),
};

export const pips = (k: number) => `<div class="pips">${[1, 2, 3, 4].map((i) => `<i class="${i <= k ? 'on' : ''}"></i>`).join('')}</div>`;
