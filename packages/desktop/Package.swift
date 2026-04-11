// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AutopodDesktop",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "AutopodUI", targets: ["AutopodUI"]),
        .library(name: "AutopodClient", targets: ["AutopodClient"]),
        .library(name: "AutopodDesktop", targets: ["AutopodDesktop"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "AutopodUI",
            dependencies: [
                "AutopodClient",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "Sources/AutopodUI"
        ),
        .target(
            name: "AutopodClient",
            path: "Sources/AutopodClient"
        ),
        .target(
            name: "AutopodDesktop",
            dependencies: ["AutopodUI", "AutopodClient"],
            path: "Sources/AutopodDesktop"
        ),
        .executableTarget(
            name: "AutopodDesktopExe",
            dependencies: ["AutopodUI", "AutopodClient", "AutopodDesktop"],
            path: "Sources/AutopodDesktopExe"
        ),
        .testTarget(
            name: "AutopodClientTests",
            dependencies: ["AutopodClient", "AutopodUI", "AutopodDesktop"],
            path: "Tests/AutopodClientTests"
        ),
    ]
)
