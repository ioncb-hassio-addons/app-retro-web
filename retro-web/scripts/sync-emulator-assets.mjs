import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import CleanCSS from "clean-css";
import { minify } from "terser";

const require = createRequire(import.meta.url);
const publicRoot = path.resolve("public", "vendor", "emulatorjs", "data");
const dataRoot = path.dirname(
  require.resolve("@emulatorjs/emulatorjs/data/loader.js"),
);

await mkdir(path.dirname(publicRoot), { recursive: true });
await cp(dataRoot, publicRoot, { recursive: true });

const scriptNames = [
  "emulator.js",
  "nipplejs.js",
  "shaders.js",
  "storage.js",
  "gamepad.js",
  "GameManager.js",
  "socket.io.min.js",
  "compression.js",
];
const source = (
  await Promise.all(
    scriptNames.map((name) =>
      readFile(path.join(dataRoot, "src", name), "utf8"),
    ),
  )
)
  .join("\n")
  .replace(
    'if (this.debug || (window.location && ["localhost", "127.0.0.1"].includes(location.hostname))) this.checkForUpdates();',
    "// Runtime update checks are disabled for fully self-hosted operation.",
  )
  .replace(
    /if \(this\.config\.dontExtractBIOS === true\) \{\s*this\.gameManager\.FS\.writeFile\(assetUrl, new Uint8Array\(input\)\);\s*return resolve\(assetUrl\);\s*\}/,
    `if (this.config.dontExtractBIOS === true) {
      const biosName =
        typeof assetUrl === "string"
          ? assetUrl.includes("#")
            ? assetUrl.split("#").pop()
            : assetUrl.split("/").pop().split("?")[0]
          : "bios.zip";
      this.gameManager.FS.writeFile(\`/\${biosName}\`, new Uint8Array(input));
      return resolve(assetUrl);
    }`,
  );
const minified = await minify(source, {
  compress: true,
  mangle: true,
  format: { comments: false },
});
if (!minified.code) throw new Error("Failed to generate EmulatorJS bundle");
await writeFile(path.join(publicRoot, "emulator.min.js"), minified.code);

const css = await readFile(path.join(dataRoot, "emulator.css"), "utf8");
const minifiedCss = new CleanCSS({ level: 2 }).minify(css);
if (minifiedCss.errors.length > 0) {
  throw new Error(`Failed to generate EmulatorJS CSS: ${minifiedCss.errors}`);
}
await writeFile(path.join(publicRoot, "emulator.min.css"), minifiedCss.styles);

const english = JSON.parse(
  await readFile(path.join(publicRoot, "localization", "en-US.json"), "utf8"),
);
const portableArrows = {
  CU: "↑",
  CD: "↓",
  CL: "←",
  CR: "→",
};
await writeFile(
  path.join(publicRoot, "localization", "en-US.json"),
  `${JSON.stringify({ ...english, ...portableArrows }, null, 2)}\n`,
);
const spanishPath = path.join(publicRoot, "localization", "es-ES.json");
const spanish = JSON.parse(await readFile(spanishPath, "utf8"));
const spanishOverrides = {
  "-1": "-1",
  "+1": "+1",
  ...portableArrows,
  Disks: "Discos",
  "Exit Emulation": "Salir de la emulación",
  "D-PAD UP": "D-PAD ARRIBA",
  "D-PAD DOWN": "D-PAD ABAJO",
  "D-PAD LEFT": "D-PAD IZQUIERDA",
  "D-PAD RIGHT": "D-PAD DERECHA",
  LEFT_TOP_SHOULDER: "HOMBRO SUPERIOR IZQUIERDO",
  RIGHT_TOP_SHOULDER: "HOMBRO SUPERIOR DERECHO",
  LEFT_BOTTOM_SHOULDER: "HOMBRO INFERIOR IZQUIERDO",
  RIGHT_BOTTOM_SHOULDER: "HOMBRO INFERIOR DERECHO",
  "Requires restart": "Requiere reinicio",
  "Core (Requires restart)": "Núcleo (requiere reinicio)",
  "Core (Requiere reinicio)": "Núcleo (requiere reinicio)",
  "WebGL2 (Requires restart)": "WebGL2 (requiere reinicio)",
  "WebGL2 (Requiere reinicio)": "WebGL2 (requiere reinicio)",
  "Rewind Enabled (Requires restart)":
    "Rebobinado habilitado (requiere reinicio)",
  "Rewind Enabled (Requiere reinicio)":
    "Rebobinado habilitado (requiere reinicio)",
  "RetroArch Options (Requires restart)":
    "Opciones de RetroArch (requiere reinicio)",
  "RetroArch Options (Requiere reinicio)":
    "Opciones de RetroArch (requiere reinicio)",
  "Video Rotation": "Rotación de video",
  "Screenshot Source": "Origen de captura",
  "Screenshot Format": "Formato de captura",
  "Screenshot Upscale": "Escala de captura",
  "Screen Recording FPS": "FPS de grabación",
  "Screen Recording Format": "Formato de grabación",
  "Screen Recording Upscale": "Escala de grabación",
  "Screen Recording Video Bitrate": "Bitrate de video",
  "Screen Recording Audio Bitrate": "Bitrate de audio",
  "Menubar Mouse Trigger": "Activación de barra con ratón",
  "Downward Movement": "Movimiento hacia abajo",
  "Movement Anywhere": "Movimiento en cualquier lugar",
  "Direct Keyboard Input": "Entrada directa de teclado",
  "Forward Alt key": "Reenviar tecla Alt",
  "Lock Mouse": "Bloquear ratón",
  "Are you sure you want to exit?": "¿Seguro que quieres salir?",
  Exit: "Salir",
  Cancel: "Cancelar",
  "System Save interval": "Intervalo de guardado del sistema",
  visible: "visible",
  hidden: "oculto",
};
await writeFile(
  spanishPath,
  `${JSON.stringify({ ...english, ...spanish, ...spanishOverrides }, null, 2)}\n`,
);

const coresRoot = path.join(publicRoot, "cores");
await mkdir(path.join(coresRoot, "reports"), { recursive: true });

const cores = [
  "fbneo",
  "fceumm",
  "gambatte",
  "mgba",
  "mupen64plus_next",
  "snes9x",
];

for (const core of cores) {
  const packageRoot = path.dirname(
    require.resolve(`@emulatorjs/core-${core}/package.json`),
  );
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(packageRoot, { withFileTypes: true }),
  );
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith("-wasm.data")) {
      await cp(
        path.join(packageRoot, entry.name),
        path.join(coresRoot, entry.name),
      );
    }
  }
  await cp(path.join(packageRoot, "reports"), path.join(coresRoot, "reports"), {
    recursive: true,
    force: true,
  });
}

const coreMetadata = {};
for (const core of cores) {
  const reportPath = path.join(coresRoot, "reports", `${core}.json`);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  coreMetadata[core] = {
    buildId: report.buildStart || null,
    version: report.version || null,
  };
}

await writeFile(
  path.join(path.dirname(publicRoot), "manifest.json"),
  `${JSON.stringify(
    {
      emulatorVersion: "4.2.3",
      cores: coreMetadata,
    },
    null,
    2,
  )}\n`,
);
