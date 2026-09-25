import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import * as git from './git.js'

/**
 * Native mobile version files. Both app stores need two values: a
 * user-facing version (iOS `MARKETING_VERSION` / `CFBundleShortVersionString`,
 * Android `versionName`), which is set to the new release version, and a
 * build number (iOS `CURRENT_PROJECT_VERSION` / `CFBundleVersion`, Android
 * `versionCode`) that must strictly increase across uploads, which is set to
 * one more than the highest literal build number in the platform's files
 * on origin/main -- so every target/flavor ends up on the same, new build
 * number, and re-running against an already-bumped release branch checkout
 * doesn't bump it a second time.
 *
 * Only literal values are touched. Anything computed or indirected (e.g.
 * Flutter's `$(FLUTTER_BUILD_NAME)`, Info.plist's `$(MARKETING_VERSION)`,
 * `versionCode rootProject.ext.versionCode`) is left alone, so projects
 * that already derive these from elsewhere keep working. Like the TOML
 * edits in github.ts, these are targeted string replacements that leave the
 * rest of each file byte-for-byte untouched.
 */
interface MobilePlatform {
  name: string
  findFiles(packagePath: string): string[]
  buildNumbers(content: string): number[]
  apply(content: string, version: string, buildNumber: number): string
}

// A pbxproj value is either bare (`1.2.3`) or quoted (`"1.2.3"`); anything
// referencing a build setting (`$(...)`) is deliberately not matched.
const PBXPROJ_MARKETING_VERSION = /(\bMARKETING_VERSION = )("?)([^";\n$]*)\2;/g
const PBXPROJ_BUILD_NUMBER = /(\bCURRENT_PROJECT_VERSION = )("?)(\d+)\2;/g
const PLIST_MARKETING_VERSION =
  /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<$]*)(<\/string>)/g
const PLIST_BUILD_NUMBER =
  /(<key>CFBundleVersion<\/key>\s*<string>)(\d+)(<\/string>)/g
// Groovy (`versionName "1.2.3"`) and Kotlin DSL (`versionName = "1.2.3"`).
const GRADLE_VERSION_NAME = /^(\s*versionName\s*(?:=\s*)?)(["'])([^"']*)\2/gm
const GRADLE_VERSION_CODE = /^(\s*versionCode\s*(?:=\s*)?)(\d+)\b/gm

function numbersFrom(content: string, regex: RegExp, group: number): number[] {
  return [...content.matchAll(regex)].map((m) => parseInt(m[group], 10))
}

function listDir(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir).sort()
}

/** The package directory itself, plus a conventional `<name>/` subdirectory
 * (React Native, Capacitor and Flutter keep native projects in `ios/` and
 * `android/`). */
function platformRoots(packagePath: string, subdir: string): string[] {
  return [packagePath, path.join(packagePath, subdir)]
}

const ios: MobilePlatform = {
  name: 'iOS',
  findFiles(packagePath) {
    const files: string[] = []
    for (const root of platformRoots(packagePath, 'ios')) {
      for (const entry of listDir(root)) {
        if (entry.endsWith('.xcodeproj')) {
          const pbxproj = path.join(root, entry, 'project.pbxproj')
          if (fs.existsSync(pbxproj)) {
            files.push(pbxproj)
          }
        }
        // Older projects hard-code versions in Info.plist instead of
        // pointing it at the MARKETING_VERSION build setting.
        const plist = path.join(root, entry, 'Info.plist')
        if (fs.existsSync(plist)) {
          files.push(plist)
        }
      }
    }
    return files
  },
  buildNumbers(content) {
    return [
      ...numbersFrom(content, PBXPROJ_BUILD_NUMBER, 3),
      ...numbersFrom(content, PLIST_BUILD_NUMBER, 2)
    ]
  },
  apply(content, version, buildNumber) {
    return content
      .replace(PBXPROJ_MARKETING_VERSION, `$1$2${version}$2;`)
      .replace(PBXPROJ_BUILD_NUMBER, `$1$2${buildNumber}$2;`)
      .replace(PLIST_MARKETING_VERSION, `$1${version}$3`)
      .replace(PLIST_BUILD_NUMBER, `$1${buildNumber}$3`)
  }
}

const android: MobilePlatform = {
  name: 'Android',
  findFiles(packagePath) {
    const files: string[] = []
    for (const root of platformRoots(packagePath, 'android')) {
      // The module's build file normally lives one level down (`app/`).
      for (const dir of [
        root,
        ...listDir(root).map((e) => path.join(root, e))
      ]) {
        for (const name of ['build.gradle', 'build.gradle.kts']) {
          const file = path.join(dir, name)
          if (fs.existsSync(file)) {
            files.push(file)
          }
        }
      }
    }
    return files
  },
  buildNumbers(content) {
    return numbersFrom(content, GRADLE_VERSION_CODE, 2)
  },
  apply(content, version, buildNumber) {
    return content
      .replace(GRADLE_VERSION_NAME, `$1$2${version}$2`)
      .replace(GRADLE_VERSION_CODE, `$1${buildNumber}`)
  }
}

/**
 * Updates every iOS and Android version file found in `packagePath` (or
 * its `ios/` / `android/` subdirectories) and returns the paths it wrote.
 */
export function updateMobileVersions(
  packagePath: string,
  newVersion: string
): string[] {
  const written: string[] = []

  for (const platform of [ios, android]) {
    const files = [...new Set(platform.findFiles(packagePath))]
    const contents = new Map(
      files.map((file) => [file, fs.readFileSync(file, 'utf-8')])
    )
    const buildNumbers = files.flatMap((file) =>
      platform.buildNumbers(
        git.getFileAtRef('origin/main', file) ?? contents.get(file)!
      )
    )
    const nextBuildNumber = Math.max(0, ...buildNumbers) + 1

    let updatedVersion = false
    for (const [file, content] of contents) {
      const updated = platform.apply(content, newVersion, nextBuildNumber)
      if (updated !== content) {
        fs.writeFileSync(file, updated)
        written.push(file)
        updatedVersion = true
      }
    }

    if (updatedVersion) {
      if (buildNumbers.length === 0) {
        core.warning(
          `No literal ${platform.name} build number found in ${packagePath}; only the version was updated`
        )
      } else {
        core.info(
          `Set ${platform.name} version to ${newVersion} (build ${nextBuildNumber}) in ${packagePath}`
        )
      }
    }
  }

  return written
}

// `version: 1.2.3+42` -- optionally quoted, the `+<build>` part optional.
const PUBSPEC_VERSION = /^(version:[ \t]*)(["']?)([^\s"'+#]+)(?:\+(\d+))?\2/m

/**
 * Updates a Flutter pubspec.yaml's `version`, which carries both the
 * user-facing version and (after `+`) the build number Flutter feeds into
 * the iOS and Android builds. The build number, when present, is bumped
 * from its value on origin/main (see above). Returns false when the file
 * has no top-level `version` field.
 */
export function updatePubspecVersion(
  pubspecPath: string,
  newVersion: string
): boolean {
  const content = fs.readFileSync(pubspecPath, 'utf-8')
  const match = PUBSPEC_VERSION.exec(content)
  if (!match) {
    return false
  }

  let version = newVersion
  if (match[4] !== undefined) {
    const base = PUBSPEC_VERSION.exec(
      git.getFileAtRef('origin/main', pubspecPath) ?? content
    )
    version += `+${parseInt(base?.[4] ?? match[4], 10) + 1}`
  }

  fs.writeFileSync(
    pubspecPath,
    content.replace(PUBSPEC_VERSION, `$1$2${version}$2`)
  )
  return true
}
