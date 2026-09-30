import Carbon.HIToolbox
import Foundation

/// One global hotkey (⌃⌥⌘F) through Carbon's RegisterEventHotKey: still the
/// only system API for a hotkey that needs no Accessibility permission.
final class Hotkey: @unchecked Sendable {
    static let shared = Hotkey()
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var action: (@MainActor () -> Void)?

    func register(_ action: @escaping @MainActor () -> Void) {
        self.action = action
        guard ref == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { Hotkey.shared.action?() } }
            return noErr
        }, 1, &spec, nil, &handler)
        let id = EventHotKeyID(signature: OSType(0x46434B50), id: 1) // 'FCKP'
        RegisterEventHotKey(UInt32(kVK_ANSI_F), UInt32(controlKey | optionKey | cmdKey), id,
                            GetApplicationEventTarget(), 0, &ref)
    }
}
