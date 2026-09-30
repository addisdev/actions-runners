// swift-tools-version: 6.0
// Fleet Cockpit's core and command-line tool. The menu bar app lives in
// App/ (generated from project.yml with XcodeGen) and links CockpitCore from
// here, so everything testable builds and tests with `swift test` alone — no
// Xcode project, no simulator.
import PackageDescription

let package = Package(
    name: "FleetCockpit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CockpitCore", targets: ["CockpitCore"]),
        .executable(name: "cockpit", targets: ["cockpit"]),
    ],
    targets: [
        .target(
            name: "CockpitCore",
            resources: [.copy("Fixtures")]
        ),
        .executableTarget(
            name: "cockpit",
            dependencies: ["CockpitCore"]
        ),
        .testTarget(
            name: "CockpitCoreTests",
            dependencies: ["CockpitCore"]
        ),
    ]
)
