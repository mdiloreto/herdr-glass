const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const GLASS_LAYOUTS = ["layouts/glass.json", "layouts/glass-insights.json"];
const HEX8_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;

function parseHexColor(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  const match = HEX_RE.exec(value);
  assert.ok(match, `${label} ("${value}") must be a #rrggbb or #rrggbbaa hex color`);
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  const a = match[4] !== undefined ? parseInt(match[4], 16) / 255 : 1;
  return { r, g, b, a, alphaHex: match[4] ? match[4].toLowerCase() : "ff" };
}

function resolveColor(value, colors, label) {
  assert.equal(typeof value, "string", `${label} must be a color string`);
  return value in colors ? colors[value] : value;
}

function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  if (!Array.isArray(node.children)) return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

for (const relPath of GLASS_LAYOUTS) {
  const layout = JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));

  test(`${relPath}: enables window blur and transparent terminal background`, () => {
    assert.equal(layout.window_blur, true, `${relPath}: window_blur must be true`);
    assert.equal(layout.terminal_opacity, 0, `${relPath}: terminal_opacity must be 0`);
  });

  test(`${relPath}: defaults to dark graphite theme so Light-mode OSes do not fall back to paper`, () => {
    assert.equal(
      layout.theme,
      "graphite",
      `${relPath}: theme must be "graphite" so Light-mode Windows/macOS never render dark text on smoked glass`,
    );
  });

  test(`${relPath}: colors.canvas and colors.background use 00 alpha with dark background RGB`, () => {
    assert.match(layout.colors.canvas, HEX8_RE, `${relPath}: colors.canvas must be #rrggbbaa`);
    assert.match(layout.colors.background, HEX8_RE, `${relPath}: colors.background must be #rrggbbaa`);

    const canvas = parseHexColor(layout.colors.canvas, `${relPath}: colors.canvas`);
    const background = parseHexColor(layout.colors.background, `${relPath}: colors.background`);

    assert.equal(canvas.alphaHex, "00", `${relPath}: colors.canvas must have 00 alpha`);
    assert.equal(background.alphaHex, "00", `${relPath}: colors.background must have 00 alpha`);
    assert.ok(
      luminance(background) < 0.5,
      `${relPath}: colors.background RGB must stay dark (luminance=${luminance(background).toFixed(3)})`,
    );
  });

  test(`${relPath}: root gradient has two translucent hex stops`, () => {
    const gradient = layout.background?.gradient;
    assert.ok(Array.isArray(gradient) && gradient.length === 2, `${relPath}: root background.gradient must have 2 stops`);
    for (const [i, stop] of gradient.entries()) {
      assert.match(stop, HEX8_RE, `${relPath}: background.gradient[${i}] must be #rrggbbaa`);
      const { a } = parseHexColor(stop, `${relPath}: background.gradient[${i}]`);
      assert.ok(a > 0 && a < 0.6, `${relPath}: background.gradient[${i}] alpha ${a.toFixed(3)} must be in (0, 0.6)`);
    }
  });

  test(`${relPath}: main pane and right panel use translucent fills and panel radius 10`, () => {
    const main = findNode(layout, "main");
    const panel = findNode(layout, "panel");
    assert.ok(main, `${relPath}: missing "main" node`);
    assert.ok(panel, `${relPath}: missing "panel" node`);

    const mainBg = main.content?.pane?.background;
    const panelBg = panel.background;
    assert.match(mainBg, HEX8_RE, `${relPath}: main.content.pane.background must be #rrggbbaa`);
    assert.match(panelBg, HEX8_RE, `${relPath}: panel.background must be #rrggbbaa`);

    const mainAlpha = parseHexColor(mainBg, `${relPath}: main.content.pane.background`).a;
    const panelAlpha = parseHexColor(panelBg, `${relPath}: panel.background`).a;
    assert.ok(mainAlpha > 0 && mainAlpha < 0.6, `${relPath}: main pane alpha ${mainAlpha.toFixed(3)} must be in (0, 0.6)`);
    assert.ok(panelAlpha > 0 && panelAlpha < 0.6, `${relPath}: panel alpha ${panelAlpha.toFixed(3)} must be in (0, 0.6)`);
    assert.equal(panel.radius, 10, `${relPath}: panel.radius must be 10`);
  });

  // Both macOS Metal (`destination_alpha_blend_factor = One`) and Windows DirectX 11
  // (`D3D11_BLEND_ONE`) accumulate destination alpha additively across stacked layers,
  // so keeping each region's sum strictly below 0.9 preserves translucency everywhere.
  test(`${relPath}: additive alpha stacks stay strictly below 0.9 across all regions`, () => {
    const sidebar = findNode(layout, "sidebar");
    const main = findNode(layout, "main");
    const panel = findNode(layout, "panel");
    assert.ok(sidebar, `${relPath}: missing "sidebar" node`);
    assert.ok(main, `${relPath}: missing "main" node`);
    assert.ok(panel, `${relPath}: missing "panel" node`);

    const outerAlpha = parseHexColor(layout.colors.background, `${relPath}: colors.background`).a;
    const gradientAlpha = Math.max(
      ...layout.background.gradient.map((stop, i) => parseHexColor(stop, `${relPath}: background.gradient[${i}]`).a),
    );
    const chromeAlpha = parseHexColor(layout.colors.chrome, `${relPath}: colors.chrome`).a;
    const sidebarBgAlpha = parseHexColor(
      resolveColor(sidebar.background, layout.colors, `${relPath}: sidebar.background`),
      `${relPath}: sidebar.background`,
    ).a;
    const mainPaneBgAlpha = parseHexColor(
      resolveColor(main.content.pane.background, layout.colors, `${relPath}: main.content.pane.background`),
      `${relPath}: main.content.pane.background`,
    ).a;
    const panelBgAlpha = parseHexColor(
      resolveColor(panel.background, layout.colors, `${relPath}: panel.background`),
      `${relPath}: panel.background`,
    ).a;
    const bgColorAlpha = parseHexColor(layout.colors.background, `${relPath}: colors.background`).a;

    const regions = [
      ["frame/gap", outerAlpha + gradientAlpha],
      ["tabs/usage bar (chrome)", outerAlpha + gradientAlpha + chromeAlpha],
      ["sidebar (sidebar.background + mod chrome)", outerAlpha + gradientAlpha + sidebarBgAlpha + chromeAlpha],
      ["main pane + pane header (colors.background)", outerAlpha + gradientAlpha + mainPaneBgAlpha + bgColorAlpha],
      ["right panel + panel mod (colors.background)", outerAlpha + gradientAlpha + panelBgAlpha + bgColorAlpha],
    ];

    for (const [region, sum] of regions) {
      assert.ok(sum < 0.9, `${relPath}: additive alpha for ${region} is ${sum.toFixed(3)}, expected < 0.9`);
    }
  });
}
