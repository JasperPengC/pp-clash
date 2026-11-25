import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

it('Android 初始化安装品牌自适应图标、主题图标与通知图标，重复执行结果一致', () => {
  const project = mkdtempSync(join(tmpdir(), 'ppclash-android-icons-'));
  folders.push(project);
  const save = (file: string, value: string) => { mkdirSync(dirname(join(project, file)), { recursive: true }); writeFileSync(join(project, file), value); };
  save('app/build.gradle.kts', `android {
    compileSdk = 37
    defaultConfig {
        targetSdk = 37
    }
    buildTypes {
        getByName("debug") {
            isJniDebuggable = true
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
        }
    }
}
dependencies {
}
`);
  save('gradle/wrapper/gradle-wrapper.properties', 'zipStoreBase=GRADLE_USER_HOME\n');
  save('app/src/main/AndroidManifest.xml', '<manifest>\n    <uses-permission android:name="android.permission.INTERNET" />\n    <application android:icon="@mipmap/ic_launcher">\n            <activity\n            android:name=".MainActivity"\n            android:exported="true" />\n        <provider />\n    </application>\n</manifest>');
  mkdirSync(join(project, 'app/src/main/java/com/ppclash/app'), { recursive: true });
  save('stub.aar', 'fixture');
  for (const file of ['sub-store.bundle.cjs', 'service-bootstrap.cjs', 'build-provenance.json', 'runtime-manifest.json']) save(`runtime/${file}`, `fixture ${file}`);
  for (const target of ['android-arm64', 'android-x64']) {
    for (const file of ['node', 'manifest.json', 'LICENSE']) save(`runtime/${target}/${file}`, `fixture ${target}/${file}`);
  }
  const configure = () => execFileSync(process.execPath, ['scripts/configure-android.mjs', project, join(project, 'stub.aar'), join(project, 'runtime')], { stdio: 'pipe' });
  configure();
  const gradle = readFileSync(join(project, 'app/build.gradle.kts'), 'utf8');
  expect(gradle).toContain('isJniDebuggable = false');
  expect(gradle).toContain('jniLibs.keepDebugSymbols.clear()');
  expect(gradle).toContain('jniLibs.useLegacyPackaging = true');
  expect(gradle).not.toContain('jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")');
  expect(gradle).toContain('jniLibs.keepDebugSymbols.add("**/libppclash_node.so")');
  expect(readFileSync(join(project, 'app/src/main/jniLibs/arm64-v8a/libppclash_node.so'), 'utf8')).toBe('fixture android-arm64/node');
  expect(readFileSync(join(project, 'app/src/main/jniLibs/x86_64/libppclash_node.so'), 'utf8')).toBe('fixture android-x64/node');
  expect(readFileSync(join(project, 'app/src/main/assets/ppclash-cloud/service-bootstrap.cjs'), 'utf8')).toBe('fixture service-bootstrap.cjs');
  const manifest = readFileSync(join(project, 'app/src/main/AndroidManifest.xml'), 'utf8');
  expect(manifest).toContain('android:windowSoftInputMode="adjustNothing"');
  const activity = readFileSync(join(project, 'app/src/main/java/com/ppclash/app/MainActivity.kt'), 'utf8');
  expect(activity).toContain('WindowInsetsCompat.Type.ime()');
  expect(activity).toContain("CustomEvent('ppclash-ime'");
  const res = join(project, 'app/src/main/res');
  const adaptive = join(res, 'mipmap-anydpi-v26/ic_launcher.xml');
  expect(existsSync(adaptive)).toBe(true);
  expect(readFileSync(adaptive, 'utf8')).toContain('<adaptive-icon');
  expect(readFileSync(join(res, 'mipmap-anydpi-v33/ic_launcher.xml'), 'utf8')).toContain('<monochrome');
  const sourcePath = readFileSync('src-tauri/icons/tray.svg', 'utf8').match(/<path d="([^"]+)"/)![1];
  expect(readFileSync(join(res, 'drawable/ppclash_icon_foreground.xml'), 'utf8')).toContain(sourcePath);
  expect(readFileSync(join(res, 'drawable/ic_stat_ppclash.xml'), 'utf8')).toContain(sourcePath);
  for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]] as const) {
    const png = readFileSync(join(res, `mipmap-${density}/ic_launcher.png`));
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
  const original = readFileSync(adaptive);
  configure();
  expect(readFileSync(adaptive)).toEqual(original);
});
