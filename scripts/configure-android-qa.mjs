// Prepare an isolated generated project for device tests without replacing the installed app.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = realpathSync(process.argv[2] ?? '');
const cache = `${realpathSync(join(repo, '.cache'))}/`;
if (!project.startsWith(cache)) throw new Error('QA project must be an isolated copy inside this repository’s .cache directory');
const app = join(project, 'app');
const gradlePath = join(app, 'build.gradle.kts');
let gradle = readFileSync(gradlePath, 'utf8');
for (const [from, to] of [
  ['        applicationId = "com.ppclash.app"', '        applicationId = "com.ppclash.app"\n        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"'],
  ['        getByName("debug") {', '        getByName("debug") {\n            applicationIdSuffix = ".platformqa"'],
  ['    androidTestImplementation("androidx.test.ext:junit:1.1.4")', '    androidTestImplementation("androidx.test.ext:junit:1.2.1")\n    androidTestImplementation("androidx.test:runner:1.6.2")\n    androidTestImplementation("androidx.test:core:1.6.1")'],
]) {
  if (gradle.includes(to)) continue;
  if (!gradle.includes(from)) throw new Error(`Unsupported QA template: ${from}`);
  gradle = gradle.replace(from, to);
}
gradle = gradle.replace(/rootDirRel = "[^"]+"/, `rootDirRel = ${JSON.stringify(relative(app, join(repo, 'src-tauri')))}`);
writeFileSync(gradlePath, gradle);
const activityPath = join(app, 'src/main/java/com/ppclash/app/MainActivity.kt');
let activity = readFileSync(activityPath, 'utf8');
const keepScreenOn = '        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)';
if (!activity.includes(keepScreenOn)) {
  const creation = '        super.onCreate(savedInstanceState)';
  if (!activity.includes(creation)) throw new Error('Unsupported QA activity template');
  activity = activity.replace(creation, `${creation}\n${keepScreenOn}`);
  writeFileSync(activityPath, activity);
}
const tests = join(app, 'src/androidTest/java/com/ppclash/app');
mkdirSync(tests, { recursive: true });
for (const name of readdirSync(join(repo, 'src-tauri/android/tests')).filter(name => name.endsWith('.kt'))) {
  copyFileSync(join(repo, 'src-tauri/android/tests', name), join(tests, name));
}
if (!existsSync(join(app, 'tauri.build.gradle.kts'))) throw new Error('Run the normal Tauri Android initialization first');
console.log(`Isolated Android QA prepared: ${project}\nPackage: com.ppclash.app.platformqa (debug only)`);
