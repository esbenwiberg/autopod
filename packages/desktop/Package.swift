// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AutopodDesktop",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "AutopodUI", targets: ["AutopodUI"]),
        .library(name: "AutopodClient", targets: ["AutopodClient"]),
    ],
    targets: [
        .target(
            name: "AutopodUI",
            path: "Sources/AutopodUI"
        ),
        .target(
            name: "AutopodClient",
            path: "Sources/AutopodClient"
        ),
        .executableTarget(
            name: "AutopodDesktop",
            dependencies: ["AutopodUI", "AutopodClient"],
            path: "Sources/AutopodDesktop"
        ),
        .testTarget(
            name: "AutopodClientTests",
            dependencies: ["AutopodClient", "AutopodUI", "AutopodDesktop"],
            path: "Tests/AutopodClientTests"
        ),
    ]
)
