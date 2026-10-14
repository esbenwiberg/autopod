import SwiftUI
import WebKit

/// Native/web boundary. Only bundled code runs here; daemon credentials never cross this bridge.
struct VillageWebView: NSViewRepresentable {
    let snapshot: VillageSnapshot
    let onSelect: (VillageActor) -> Void
    let onFailure: (String) -> Void

    static var entryURL: URL? {
        Bundle.module.url(forResource: "index", withExtension: "html", subdirectory: "Village")
    }

    func makeCoordinator() -> Coordinator { Coordinator(onSelect: onSelect, onFailure: onFailure) }

    func makeNSView(context: Context) -> WKWebView {
        Self.makeWebView(snapshot: snapshot, coordinator: context.coordinator)
    }

    static func makeWebView(snapshot: VillageSnapshot, coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(coordinator, name: "village")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = coordinator
        coordinator.webView = view
        coordinator.update(snapshot)
        if let url = Self.entryURL {
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            coordinator.startTimeout()
        } else {
            Task { @MainActor in coordinator.onFailure("The bundled village renderer is missing.") }
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.onSelect = onSelect
        context.coordinator.onFailure = onFailure
        context.coordinator.update(snapshot)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.stop()
        view.stopLoading()
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "village")
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        var onSelect: (VillageActor) -> Void
        var onFailure: (String) -> Void
        private var latest: VillageSnapshot?
        private var delivered: VillageSnapshot?
        private var ready = false
        private var sending = false
        private var stopped = false
        private var timeout: Task<Void, Never>?

        init(onSelect: @escaping (VillageActor) -> Void, onFailure: @escaping (String) -> Void) {
            self.onSelect = onSelect; self.onFailure = onFailure
        }

        func startTimeout() {
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                guard let self, !self.ready, !self.stopped else { return }
                self.fail("The renderer did not become ready. Try reloading the village.")
            }
        }

        func stop() { stopped = true; ready = false; timeout?.cancel() }

        func update(_ snapshot: VillageSnapshot) {
            latest = snapshot
            flush()
        }

        private func flush() {
            guard ready, !stopped, !sending, let webView, let snapshot = latest,
                  snapshot != delivered else { return }
            do {
                let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
                sending = true
                // Arguments are structured data. Never interpolate tasks/logs into executable JS.
                webView.callAsyncJavaScript(
                    "return window.AutoPodVillageHost.receive(snapshot)",
                    arguments: ["snapshot": object], in: nil, in: .page
                ) { [weak self] result in
                    guard let self, !self.stopped else { return }
                    self.sending = false
                    switch result {
                    case .success:
                        self.delivered = snapshot
                        self.flush() // Coalesce updates received while JS was busy.
                    case .failure:
                        self.fail("The village could not accept pod updates. Try reloading it.")
                    }
                }
            } catch { fail("The pod scene could not be encoded.") }
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !stopped, message.frameInfo.isMainFrame,
                  let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                guard body["schemaVersion"] as? Int == VillageSnapshot.version else {
                    fail("The village renderer uses an unsupported scene version."); return
                }
                ready = true
                timeout?.cancel()
                flush()
            case "select":
                guard ready, let id = body["actorId"] as? String,
                      let actor = latest?.actor(id: id) else { return }
                onSelect(actor)
            case "error": fail("The bundled village renderer could not start or update.")
            default: break
            }
        }

        private func fail(_ message: String) {
            guard !stopped else { return }
            stop()
            onFailure(message)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail("The village page failed to load.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail("The village page failed to load.")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            fail("The village renderer stopped. Reload it to restore the latest pod state.")
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            // The initial bundled document is the only allowed navigation, including popups.
            guard action.navigationType == .other, action.targetFrame?.isMainFrame == true,
                  action.request.url?.standardizedFileURL == VillageWebView.entryURL?.standardizedFileURL
            else { return .cancel }
            return .allow
        }
    }
}
