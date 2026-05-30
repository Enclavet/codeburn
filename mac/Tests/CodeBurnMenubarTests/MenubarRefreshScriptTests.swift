import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Menubar refresh script")
struct MenubarRefreshScriptTests {
    @Test("scriptEnvironment exposes a safe argv and augmented PATH")
    func scriptEnvironmentIsSafe() {
        let env = CodeburnCLI.scriptEnvironment()
        #expect(!env.argv.isEmpty)
        #expect(env.argv.allSatisfy { CodeburnCLI.isSafe($0) })
        // Homebrew + /usr/local are always appended for GUI-launched apps.
        #expect(env.path.contains("/opt/homebrew/bin"))
        #expect(env.path.contains("/usr/local/bin"))
    }
}
