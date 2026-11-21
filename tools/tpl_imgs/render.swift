// 使い方: swift render.swift in.html out.png [幅 高さ]
// 画面を出さずに WKWebView で HTML を描いて PNG にする（新しい Chrome は立てない）
import AppKit
import WebKit

let a = CommandLine.arguments
let inPath = a[1], outPath = a[2]
let w = a.count > 3 ? Double(a[3])! : 1080, h = a.count > 4 ? Double(a[4])! : 1350

class D: NSObject, WKNavigationDelegate {
    func webView(_ v: WKWebView, didFinish n: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            let c = WKSnapshotConfiguration(); c.rect = CGRect(x: 0, y: 0, width: w, height: h); c.snapshotWidth = NSNumber(value: w)
            v.takeSnapshot(with: c) { img, err in
                guard let img = img, let t = img.tiffRepresentation, let r = NSBitmapImageRep(data: t), let p = r.representation(using: .png, properties: [:]) else { print("失敗:", err as Any); exit(1) }
                try! p.write(to: URL(fileURLWithPath: outPath)); print("ok", Int(r.pixelsWide), Int(r.pixelsHigh)); exit(0)
            }
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let v = WKWebView(frame: CGRect(x: 0, y: 0, width: w, height: h))
let d = D(); v.navigationDelegate = d
let u = URL(fileURLWithPath: inPath)
v.loadFileURL(u, allowingReadAccessTo: u.deletingLastPathComponent())
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("時間切れ"); exit(2) }
app.run()
