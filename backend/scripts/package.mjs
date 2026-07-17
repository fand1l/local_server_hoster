// @ts-check
/**
 * Складання самодостатнього бінара панелі для ПОТОЧНОЇ ОС.
 *
 * Конвеєр (див. README, розділ «Збірка exe»):
 *   1. esbuild:  src/index.ts (ESM) → build/bundle.cjs (єдиний CommonJS-файл).
 *      Усі npm-залежності лишаються external і беруться з node_modules —
 *      так ми не ламаємо динамічні require() усередині fastify/dockerode,
 *      і водночас позбуваємось ESM, з яким pkg працює погано.
 *   2. pkg:      build/bundle.cjs → бінар (mc-hoster[.exe]) з вшитим Node 22
 *      і нативним аддоном better-sqlite3 (додається як asset за абсолютним
 *      шляхом — через npm workspaces він лежить у кореневому node_modules).
 *   3. staging:  збираємо теку dist-release/<пакет>/ = бінар + frontend/dist
 *      (сайдкар, який config.ts шукає поруч із exe) + інструкція запуску.
 *      CI зіпує цю теку в асет релізу.
 *
 * Крос-компіляція нативних модулів ненадійна, тож кожен раннер у GitHub
 * Actions збирає бінар під СВОЮ ОС (matrix win/mac/linux).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendDir, '..');

/** Node-платформа → короткий ярлик ОС для імені пакета і суфікса pkg. */
const PKG_PLATFORM = { win32: 'win', darwin: 'macos', linux: 'linux' };

function log(step) {
  console.log(`\n▶ ${step}`);
}

function run(command, args, cwd = backendDir) {
  console.log(`  $ ${command} ${args.join(' ')}`);
  const res = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    throw new Error(`Команда завершилася з кодом ${res.status}: ${command} ${args.join(' ')}`);
  }
}

async function main() {
  const platform = PKG_PLATFORM[process.platform];
  if (!platform) throw new Error(`Непідтримувана платформа: ${process.platform}`);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const nodeRange = 'node22';
  const target = `${nodeRange}-${platform}-${arch}`;
  const exeName = process.platform === 'win32' ? 'mc-hoster.exe' : 'mc-hoster';

  // Фронтенд має бути зібраний заздалегідь (npm run build -w frontend).
  const frontendDist = path.join(repoRoot, 'frontend', 'dist');
  if (!fs.existsSync(path.join(frontendDist, 'index.html'))) {
    throw new Error('Не знайдено frontend/dist. Спершу виконайте `npm run build -w frontend`.');
  }

  const buildDir = path.join(backendDir, 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  // --- 1. esbuild ----------------------------------------------------------
  log('esbuild: бандл ESM → CommonJS');
  run('npm', ['run', 'bundle']);
  const bundlePath = path.join(buildDir, 'bundle.cjs');
  if (!fs.existsSync(bundlePath)) throw new Error('esbuild не створив build/bundle.cjs');

  // --- 2. pkg --------------------------------------------------------------
  log(`pkg: бінар під ${target}`);
  // Нативний аддон better-sqlite3 лежить у кореневому node_modules (workspaces),
  // тому додаємо його абсолютним шляхом через згенерований конфіг pkg.
  const betterSqlite3Dir = path.dirname(require.resolve('better-sqlite3/package.json'));
  const pkgConfig = {
    // ci: pkg скаржиться на bytecode для деяких таргетів — лишаємо як є (JS у снапшоті).
    assets: [
      path.join(betterSqlite3Dir, 'build', 'Release', '*.node').replace(/\\/g, '/'),
      path.join(betterSqlite3Dir, 'package.json').replace(/\\/g, '/'),
    ],
    scripts: [],
  };
  const pkgConfigPath = path.join(buildDir, 'pkg-config.json');
  fs.writeFileSync(pkgConfigPath, JSON.stringify(pkgConfig, null, 2));

  const exePath = path.join(buildDir, exeName);
  run('npx', [
    '--yes',
    '@yao-pkg/pkg',
    bundlePath,
    '--targets',
    target,
    '--config',
    pkgConfigPath,
    '--output',
    exePath,
    '--compress',
    'GZip',
  ]);
  if (!fs.existsSync(exePath)) throw new Error('pkg не створив виконуваний файл');

  // --- 3. staging ----------------------------------------------------------
  const packageName = `mc-hoster-${platform}-${arch}`;
  const stageDir = path.join(repoRoot, 'dist-release', packageName);
  log(`staging: ${path.relative(repoRoot, stageDir)}`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  fs.copyFileSync(exePath, path.join(stageDir, exeName));
  if (process.platform !== 'win32') fs.chmodSync(path.join(stageDir, exeName), 0o755);
  fs.cpSync(frontendDist, path.join(stageDir, 'frontend', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'README.txt'), runInstructions(platform, exeName));

  // Розмір для наочності у логах CI.
  const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
  log(`Готово: ${packageName} (бінар ${sizeMb} МБ)`);
  console.log(`  Тека для zip: ${stageDir}`);

  // Експортуємо ім'я пакета для наступних кроків GitHub Actions.
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `package_name=${packageName}${os.EOL}`);
  }
}

function runInstructions(platform, exeName) {
  const common = [
    'MC Hoster — локальна панель Minecraft-серверів',
    '================================================',
    '',
    'ВИМОГА: на комп’ютері має бути встановлений і запущений Docker',
    '  • Windows / macOS: Docker Desktop  → https://www.docker.com/products/docker-desktop/',
    '  • Linux: пакет docker / dockerd',
    '',
    'Без Docker панель відкриється, але керувати серверами не зможе.',
    '',
  ];
  const launch =
    platform === 'win'
      ? [
          'ЗАПУСК:',
          `  Двічі клацніть ${exeName} (або запустіть у PowerShell).`,
          '  Windows SmartScreen може попередити про невідомого видавця —',
          '  «Докладніше» → «Виконати попри все» (бінар без цифрового підпису).',
        ]
      : platform === 'macos'
        ? [
            'ЗАПУСК:',
            `  У терміналі: ./${exeName}`,
            '  Перший раз macA Gatekeeper заблокує непідписаний бінар:',
            `  Системні параметри → Конфіденційність і безпека → «Усе одно відкрити»,`,
            `  або одноразово: xattr -d com.apple.quarantine ${exeName}`,
          ]
        : [
            'ЗАПУСК:',
            `  У терміналі: ./${exeName}`,
            '  Користувач має бути в групі docker (sudo usermod -aG docker $USER).',
          ];
  const tail = [
    '',
    'Після запуску відкрийте у браузері:  http://127.0.0.1:8080',
    '',
    'Поруч із цим файлом має лежати тека frontend/ — не розділяйте їх.',
    'Дані серверів зберігаються у ~/.mc-hoster (змінюється через MC_HOSTER_DATA_DIR).',
  ];
  return [...common, ...launch, ...tail].join('\n');
}

main().catch((err) => {
  console.error(`\n✖ Пакування не вдалося: ${err.message}`);
  process.exit(1);
});
