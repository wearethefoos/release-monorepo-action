import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as git from './git.js'
import { updateMobileVersions, updatePubspecVersion } from './mobile.js'

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn()
}))

vi.mock('./git.js', () => ({
  getFileAtRef: vi.fn()
}))

const mockGetFileAtRef = vi.mocked(git.getFileAtRef)

const PBXPROJ = `// !$*UTF8*$!
{
		1 /* Debug */ = {
			buildSettings = {
				CURRENT_PROJECT_VERSION = 41;
				MARKETING_VERSION = 1.2.3;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.app;
			};
		};
		2 /* Release */ = {
			buildSettings = {
				CURRENT_PROJECT_VERSION = 42;
				MARKETING_VERSION = "1.2.3";
			};
		};
		3 /* Tests */ = {
			buildSettings = {
				MARKETING_VERSION = "$(FLUTTER_BUILD_NAME)";
				CURRENT_PROJECT_VERSION = "$(FLUTTER_BUILD_NUMBER)";
			};
		};
}
`

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>1.2.3</string>
	<key>CFBundleVersion</key>
	<string>7</string>
</dict>
</plist>
`

const BUILD_GRADLE = `android {
    defaultConfig {
        applicationId "com.example.app"
        versionCode 12
        versionName "1.2.3"
    }
}
`

const BUILD_GRADLE_KTS = `android {
    defaultConfig {
        applicationId = "com.example.app"
        versionCode = 12
        versionName = "1.2.3"
    }
}
`

describe('mobile', () => {
  let dir: string

  function write(relative: string, content: string): void {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  function read(relative: string): string {
    return fs.readFileSync(path.join(dir, relative), 'utf-8')
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-test-'))
    mockGetFileAtRef.mockReset()
    mockGetFileAtRef.mockReturnValue(null)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('updateMobileVersions', () => {
    it('updates a native iOS project', () => {
      write('App.xcodeproj/project.pbxproj', PBXPROJ)

      const written = updateMobileVersions(dir, '2.0.0')

      expect(written).toEqual([path.join(dir, 'App.xcodeproj/project.pbxproj')])
      const pbxproj = read('App.xcodeproj/project.pbxproj')
      // Every configuration moves to one past the highest build number.
      expect(pbxproj).toContain(
        'CURRENT_PROJECT_VERSION = 43;\n\t\t\t\tMARKETING_VERSION = 2.0.0;'
      )
      expect(pbxproj).toContain(
        'CURRENT_PROJECT_VERSION = 43;\n\t\t\t\tMARKETING_VERSION = "2.0.0";'
      )
      // Build-setting references are left alone.
      expect(pbxproj).toContain('MARKETING_VERSION = "$(FLUTTER_BUILD_NAME)";')
      expect(pbxproj).toContain(
        'CURRENT_PROJECT_VERSION = "$(FLUTTER_BUILD_NUMBER)";'
      )
      expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.example.app;')
    })

    it('updates literal Info.plist versions using one build number for the whole project', () => {
      write('App.xcodeproj/project.pbxproj', PBXPROJ)
      write('App/Info.plist', INFO_PLIST)

      updateMobileVersions(dir, '2.0.0')

      expect(read('App/Info.plist')).toBe(
        INFO_PLIST.replace(
          '<string>1.2.3</string>',
          '<string>2.0.0</string>'
        ).replace('<string>7</string>', '<string>43</string>')
      )
    })

    it('leaves an Info.plist that references build settings untouched', () => {
      const plist = INFO_PLIST.replace('1.2.3', '$(MARKETING_VERSION)').replace(
        '<string>7</string>',
        '<string>$(CURRENT_PROJECT_VERSION)</string>'
      )
      write('App.xcodeproj/project.pbxproj', PBXPROJ)
      write('App/Info.plist', plist)

      const written = updateMobileVersions(dir, '2.0.0')

      expect(written).toEqual([path.join(dir, 'App.xcodeproj/project.pbxproj')])
      expect(read('App/Info.plist')).toBe(plist)
    })

    it('updates a native Android project (Groovy)', () => {
      write('build.gradle', 'buildscript {}\n')
      write('app/build.gradle', BUILD_GRADLE)

      const written = updateMobileVersions(dir, '2.0.0')

      expect(written).toEqual([path.join(dir, 'app/build.gradle')])
      expect(read('app/build.gradle')).toBe(
        BUILD_GRADLE.replace('versionCode 12', 'versionCode 13').replace(
          'versionName "1.2.3"',
          'versionName "2.0.0"'
        )
      )
      expect(read('build.gradle')).toBe('buildscript {}\n')
    })

    it('updates a native Android project (Kotlin DSL)', () => {
      write('app/build.gradle.kts', BUILD_GRADLE_KTS)

      updateMobileVersions(dir, '2.0.0')

      expect(read('app/build.gradle.kts')).toBe(
        BUILD_GRADLE_KTS.replace(
          'versionCode = 12',
          'versionCode = 13'
        ).replace('versionName = "1.2.3"', 'versionName = "2.0.0"')
      )
    })

    it('updates ios/ and android/ subdirectories of a React Native package', () => {
      write('package.json', '{}')
      write('ios/App.xcodeproj/project.pbxproj', PBXPROJ)
      write('android/app/build.gradle', BUILD_GRADLE)

      const written = updateMobileVersions(dir, '2.0.0')

      expect(written).toEqual([
        path.join(dir, 'ios/App.xcodeproj/project.pbxproj'),
        path.join(dir, 'android/app/build.gradle')
      ])
    })

    it('bumps the build number from origin/main, so re-runs are idempotent', () => {
      // The checkout already carries a previous run's bump (build 13).
      write(
        'app/build.gradle',
        BUILD_GRADLE.replace('versionCode 12', 'versionCode 13')
      )
      mockGetFileAtRef.mockImplementation((ref, file) =>
        ref === 'origin/main' && file === path.join(dir, 'app/build.gradle')
          ? BUILD_GRADLE
          : null
      )

      updateMobileVersions(dir, '2.0.0')

      expect(read('app/build.gradle')).toContain('versionCode 13\n')
    })

    it('leaves a non-literal versionCode alone', () => {
      write(
        'app/build.gradle',
        BUILD_GRADLE.replace(
          'versionCode 12',
          'versionCode rootProject.ext.code'
        )
      )

      updateMobileVersions(dir, '2.0.0')

      const gradle = read('app/build.gradle')
      expect(gradle).toContain('versionCode rootProject.ext.code')
      expect(gradle).toContain('versionName "2.0.0"')
    })

    it('returns nothing for a package without native projects', () => {
      write('package.json', '{}')

      expect(updateMobileVersions(dir, '2.0.0')).toEqual([])
    })
  })

  describe('updatePubspecVersion', () => {
    it('updates the version and bumps the build number', () => {
      write('pubspec.yaml', 'name: app\nversion: 1.2.3+42\n\nenvironment:\n')

      expect(
        updatePubspecVersion(path.join(dir, 'pubspec.yaml'), '2.0.0')
      ).toBe(true)
      expect(read('pubspec.yaml')).toBe(
        'name: app\nversion: 2.0.0+43\n\nenvironment:\n'
      )
    })

    it('updates a version without a build number', () => {
      write('pubspec.yaml', "name: app\nversion: '1.2.3'\n")

      updatePubspecVersion(path.join(dir, 'pubspec.yaml'), '2.0.0')

      expect(read('pubspec.yaml')).toBe("name: app\nversion: '2.0.0'\n")
    })

    it('bumps the build number from origin/main', () => {
      write('pubspec.yaml', 'version: 2.0.0+43\n')
      mockGetFileAtRef.mockReturnValue('version: 1.2.3+42\n')

      updatePubspecVersion(path.join(dir, 'pubspec.yaml'), '2.0.0')

      expect(read('pubspec.yaml')).toBe('version: 2.0.0+43\n')
    })

    it('returns false when there is no version field', () => {
      write('pubspec.yaml', 'name: app\n')

      expect(
        updatePubspecVersion(path.join(dir, 'pubspec.yaml'), '2.0.0')
      ).toBe(false)
    })
  })
})
