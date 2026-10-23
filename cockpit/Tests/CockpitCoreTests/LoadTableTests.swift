import Foundation
import Testing
@testable import CockpitCore

@Suite struct LoadTableTests {
    let json = """
    {"days":7,"host":"ultra","since":0,"samples":6,"cores":30,
     "rows":[{"busy":0,"n":2,"p50":3,"p90":4},{"busy":2,"n":4,"p50":12,"p90":30}],
     "lanes":{"mode":"observe","limits":{"heavy":4,"light":12,"total":16}}}
    """

    @Test func decodesTheDaemonAnswer() throws {
        let t = try LoadTable.decode(Data(json.utf8))
        #expect(t.rows.count == 2)
        #expect(t.rows[1] == LoadTable.Row(busy: 2, n: 4, p50: 12, p90: 30))
        #expect(t.lanes?.limits?.heavy == 4)
    }

    @Test func printsOneLinePerBusyCount() throws {
        let text = try LoadTable.decode(Data(json.utf8)).text()
        #expect(text.contains("ultra: load1 by busy runners, last 7 day(s), 6 sample(s), 30 cores"))
        #expect(text.contains("     2        4       12.0       30.0       1.0"))
        #expect(text.contains("lanes observe: heavy 4, light 12, total 16"))
    }

    @Test func toleratesAnOlderDaemonWithoutLanesOrCores() throws {
        let t = try LoadTable.decode(Data(#"{"days":1,"samples":0,"rows":[]}"#.utf8))
        #expect(t.text().contains("no samples in the window"))
    }
}
