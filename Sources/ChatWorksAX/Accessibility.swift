import AppKit
import ApplicationServices

public enum AccessibilityError: LocalizedError {
    case accessibilityPermissionMissing
    case chatGPTNotRunning
    case inputNotFound
    case writeFailed(AXError)
    case copyControlNotFound
    case sendControlNotFound
    case sendNotConfirmed
    case newChatControlNotFound
    case chatModeControlNotFound
    case chatNotFound(String)
    case ambiguousChatName(String)
    case clipboardDidNotChange

    public var errorDescription: String? {
        switch self {
        case .accessibilityPermissionMissing:
            return "Accessibility permission is required for the invoking terminal."
        case .chatGPTNotRunning:
            return "ChatGPT is not running."
        case .inputNotFound:
            return "Could not find an editable ChatGPT input."
        case .writeFailed(let error):
            return "Could not write to ChatGPT: \(error.rawValue)."
        case .copyControlNotFound:
            return "Could not find a ChatGPT message Copy control."
        case .sendControlNotFound:
            return "Could not find the ChatGPT Send control."
        case .sendNotConfirmed:
            return "ChatGPT did not confirm that the draft was submitted."
        case .newChatControlNotFound:
            return "Could not find ChatGPT's New chat control."
        case .chatModeControlNotFound:
            return "Could not find ChatGPT's Chat/Work mode control."
        case .chatNotFound(let reference):
            return "Could not find a ChatGPT chat matching '\(reference)'."
        case .ambiguousChatName(let name):
            return "More than one ChatGPT chat is named '\(name)'; use its displayed index."
        case .clipboardDidNotChange:
            return "ChatGPT did not place copied message contents on the clipboard."
        }
    }
}

public struct ChatReference: Encodable {
    public let index: Int
    public let title: String
}

public struct AssistantMessageState: Encodable {
    public let copyControlCount: Int
    public let latestCopyControlY: CGFloat?
    public let responseHeadingCount: Int
    public let scrollToBottomVisible: Bool
}

public struct ChatGPTAccessibility {
    let application: AXUIElement
    private let previousFocus: FocusSnapshot
    private static let supportedBundleIdentifiers = ["com.openai.codex", "com.openai.chat"]
    // Physical clicks remain necessary for some ChatGPT controls. Keep the
    // restoration mechanism available, but leave the pointer at the control.
    private static let restoresPointerAfterClick = false

    public static func connect(bundleIdentifier: String? = nil) throws -> Self {
        guard AXIsProcessTrusted() else { throw AccessibilityError.accessibilityPermissionMissing }
        let previousFocus = FocusSnapshot.capture()
        let identifiers = bundleIdentifier.map { [$0] } ?? supportedBundleIdentifiers
        let running = NSWorkspace.shared.runningApplications.first {
            identifiers.contains($0.bundleIdentifier ?? "") || $0.localizedName == "ChatGPT"
        }
        guard let running else { throw AccessibilityError.chatGPTNotRunning }
        running.activate(options: [])
        return Self(application: AXUIElementCreateApplication(running.processIdentifier), previousFocus: previousFocus)
    }

    public func restoreFocus() {
        previousFocus.restore()
    }

    public func inspector() -> ChatGPTAccessibilityInspector {
        ChatGPTAccessibilityInspector(application: application)
    }

    public func latestAssistantRawText() throws -> String {
        guard let copyButton = assistantCopyButtons().first else {
            throw AccessibilityError.copyControlNotFound
        }

        let clipboard = ClipboardSnapshot.capture()
        defer { clipboard.restore() }
        let pasteboard = NSPasteboard.general
        // Virtualized ChatGPT messages can expose their controls before the
        // control is onscreen. Scroll the one selected latest response into view,
        // then invoke Copy exactly once. Do not probe older controls or retry a
        // failed click: a caller must never accidentally copy another message.
        _ = AXUIElementPerformAction(copyButton, "AXScrollToVisible" as CFString)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        guard let copyFrame = frame(of: copyButton) else { throw AccessibilityError.copyControlNotFound }
        let changeCount = pasteboard.changeCount
        click(copyFrame)
        guard let text = clipboardText(after: changeCount, in: pasteboard) else {
            throw AccessibilityError.clipboardDidNotChange
        }
        return text
    }

    public func assistantMessageState() -> AssistantMessageState {
        let copyButtons = assistantCopyButtons()
        return AssistantMessageState(
            copyControlCount: copyButtons.count,
            latestCopyControlY: copyButtons.first.flatMap { frame(of: $0)?.midY },
            responseHeadingCount: descendants(of: application).count(where: isAssistantMessageHeading),
            scrollToBottomVisible: hasVisibleScrollToBottomButton()
        )
    }

    public func scrollToBottom() {
        scrollToBottomIfNeeded()
    }

    public func stage(_ text: String) throws {
        let deadline = Date().addingTimeInterval(2)
        var lastWriteError: AXError?
        while Date() < deadline {
            if let input = editableInput() {
                let result = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, text as CFTypeRef)
                if result == .success { return }
                lastWriteError = result
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if let lastWriteError { throw AccessibilityError.writeFailed(lastWriteError) }
        throw AccessibilityError.inputNotFound
    }

    public func stageAndSend(_ text: String) throws {
        try stage(text)
        // Setting an AX value is asynchronous in ChatGPT's web-based composer.
        // Give it one run-loop turn before finding and clicking its Send control.
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        try send()
    }

    public func chatReferences() -> [ChatReference] {
        chatControls().enumerated().map { offset, control in
            ChatReference(index: offset + 1, title: control.title)
        }
    }

    public func selectChat(_ reference: String) throws {
        let controls = chatControls()
        let selected: ChatControl?
        if let index = Int(reference), controls.indices.contains(index - 1) {
            selected = controls[index - 1]
        } else {
            let matches = controls.filter { $0.title.caseInsensitiveCompare(reference) == .orderedSame }
            if matches.count > 1 { throw AccessibilityError.ambiguousChatName(reference) }
            selected = matches.first
        }
        guard let selected else { throw AccessibilityError.chatNotFound(reference) }
        // AppKit exposes this action by name but does not publish a Swift constant for it.
        _ = AXUIElementPerformAction(selected.element, "AXScrollToVisible" as CFString)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        if let selectedFrame = frame(of: selected.element) {
            click(selectedFrame)
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        let result = AXUIElementPerformAction(selected.element, kAXPressAction as CFString)
        guard result == .success else { throw AccessibilityError.writeFailed(result) }
    }

    private func chatControls() -> [ChatControl] {
        let elements = descendants(of: application)
        var controls: [ChatControl] = []
        for (index, element) in elements.enumerated() where isChatActionControl(element) {
            let nearby = elements[max(0, index - 4)..<index].reversed()
            guard let control = nearby.compactMap(chatControl).first,
                  !["recents", "show more"].contains(control.title.lowercased()) else { continue }
            controls.append(control)
        }
        return controls
    }

    public func newChat() throws {
        let buttons = descendants(of: application)
            .filter(isNewChatButton)
            .compactMap { candidate -> (AXUIElement, CGRect)? in
                guard let candidateFrame = frame(of: candidate) else { return nil }
                return (candidate, candidateFrame)
            }
        guard let button = buttons.max(by: { $0.1.width * $0.1.height < $1.1.width * $1.1.height })?.0 else {
            throw AccessibilityError.newChatControlNotFound
        }
        guard let buttonFrame = frame(of: button) else { throw AccessibilityError.newChatControlNotFound }
        click(buttonFrame)
        // ChatGPT retains old message controls in its virtualized AX tree, so their
        // presence cannot confirm (or reject) the new-chat transition.
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        try activateChatMode()
    }

    public func send() throws {
        guard let input = waitsForEditableInput() else { throw AccessibilityError.inputNotFound }
        let userMessageCount = sentUserMessageControlCount()
        guard let sendButton = waitsForComposerSendButton(near: input) else {
            throw AccessibilityError.sendControlNotFound
        }
        if let frame = frame(of: sendButton) {
            click(frame)
            if waitsForSendSubmission(near: input, previousUserMessageCount: userMessageCount) { return }
        }

        _ = AXUIElementPerformAction(sendButton, kAXPressAction as CFString)
        if waitsForSendSubmission(near: input, previousUserMessageCount: userMessageCount) { return }

        AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let keySource = CGEventSource(stateID: .hidSystemState)
        CGEvent(keyboardEventSource: keySource, virtualKey: 36, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: keySource, virtualKey: 36, keyDown: false)?.post(tap: .cghidEventTap)
        guard !waitsForSendSubmission(near: input, previousUserMessageCount: userMessageCount) else { return }
        throw AccessibilityError.sendNotConfirmed
    }

    private func isEditableInput(_ element: AXUIElement) -> Bool {
        guard let role = stringAttribute(kAXRoleAttribute, of: element) else { return false }
        return role == kAXTextAreaRole || role == kAXTextFieldRole
    }

    private func editableInput() -> AXUIElement? {
        descendants(of: application).last(where: isEditableInput)
    }

    private func waitsForEditableInput() -> AXUIElement? {
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if let input = editableInput() { return input }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return editableInput()
    }

    private func isSendButton(_ element: AXUIElement) -> Bool {
        isButton(element, containing: "send")
    }

    private func isNewChatButton(_ element: AXUIElement) -> Bool {
        guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole else { return false }
        return buttonLabels(of: element).contains { $0.caseInsensitiveCompare("new chat") == .orderedSame }
    }

    private func activateChatMode() throws {
        guard let chat = waitsForChatModeControl() else {
            throw AccessibilityError.chatModeControlNotFound
        }
        click(chat.frame)
    }

    private func waitsForChatModeControl() -> (element: AXUIElement, frame: CGRect)? {
        let deadline = Date().addingTimeInterval(2)
        var firstAvailableAt: Date?
        var latest: (element: AXUIElement, frame: CGRect)?
        while Date() < deadline {
            if let chat = chatModeControl() {
                latest = chat
                if let firstAvailableAt, Date().timeIntervalSince(firstAvailableAt) >= 0.25 {
                    return chat
                }
                firstAvailableAt = firstAvailableAt ?? Date()
            } else {
                latest = nil
                firstAvailableAt = nil
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return latest
    }

    private func chatModeControl() -> (element: AXUIElement, frame: CGRect)? {
        let controls = descendants(of: application)
            .compactMap { element -> (element: AXUIElement, label: String, frame: CGRect)? in
                guard let label = modeControlLabel(of: element), let frame = frame(of: element) else { return nil }
                return (element, label, frame)
            }
        let workControls = controls.filter { $0.label.caseInsensitiveCompare("Work") == .orderedSame }
        guard let chat = controls
            .filter({ $0.label.caseInsensitiveCompare("Chat") == .orderedSame })
            .filter({ candidate in
                workControls.contains { work in
                    abs(work.frame.midY - candidate.frame.midY) < 30 && abs(work.frame.midX - candidate.frame.midX) < 250
                }
            })
            .min(by: { $0.frame.minY < $1.frame.minY }) else { return nil }
        return (chat.element, chat.frame)
    }

    private func modeControlLabel(of element: AXUIElement) -> String? {
        guard let role = stringAttribute(kAXRoleAttribute, of: element),
              [kAXButtonRole, kAXRadioButtonRole, kAXCheckBoxRole, kAXPopUpButtonRole].contains(role) else { return nil }
        return controlLabels(of: element).first { label in
            ["Chat", "Work"].contains { $0.caseInsensitiveCompare(label) == .orderedSame }
        }
    }

    private func isChatActionControl(_ element: AXUIElement) -> Bool {
        guard stringAttribute(kAXRoleAttribute, of: element) == kAXPopUpButtonRole else { return false }
        return controlLabels(of: element).contains { $0.localizedCaseInsensitiveContains("chat actions") }
    }

    private func chatControl(_ element: AXUIElement) -> ChatControl? {
        guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole,
              let title = stringAttribute(kAXTitleAttribute, of: element), !title.isEmpty else { return nil }
        return ChatControl(title: title, element: element)
    }

    private func isButton(_ element: AXUIElement, containing label: String) -> Bool {
        guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole else { return false }
        return buttonLabels(of: element).contains { $0.localizedCaseInsensitiveContains(label) }
    }

    private func buttonLabels(of element: AXUIElement) -> [String] {
        controlLabels(of: element)
    }

    private func controlLabels(of element: AXUIElement) -> [String] {
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXValueAttribute].compactMap {
            stringAttribute($0, of: element)
        }
    }

    private func descendants(of root: AXUIElement, limit: Int = 5_000) -> [AXUIElement] {
        var result: [AXUIElement] = []
        var pending = [root]
        while let element = pending.popLast(), result.count < limit {
            result.append(element)
            var children: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
               let values = children as? [AXUIElement] {
                pending.append(contentsOf: values.reversed())
            }
        }
        return result
    }

    private func waitsForSendSubmission(near input: AXUIElement, previousUserMessageCount: Int) -> Bool {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            // A disabled or absent Send button merely means that the draft is no
            // longer editable. The new user-message Edit control is ideal, but
            // ChatGPT can recycle that virtualized control. Its empty composer
            // placeholder is the reliable fallback confirmation of a submission.
            if sentUserMessageControlCount() > previousUserMessageCount || isEmptyComposer(input) {
                return true
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return false
    }

    private func isEmptyComposer(_ input: AXUIElement) -> Bool {
        guard let value = stringAttribute(kAXValueAttribute, of: input) else { return false }
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedValue.isEmpty { return true }
        return controlLabels(of: input).contains { label in
            trimmedValue.caseInsensitiveCompare(label.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame
        }
    }

    private func sentUserMessageControlCount() -> Int {
        descendants(of: application).count { isButton($0, containing: "edit message") }
    }

    private func composerSendButton(near input: AXUIElement) -> AXUIElement? {
        guard let inputFrame = frame(of: input) else { return nil }
        let inputCenter = CGPoint(x: inputFrame.midX, y: inputFrame.midY)
        return descendants(of: application)
            .filter(isSendButton)
            .compactMap { button in frame(of: button).map { (button, $0) } }
            .min { left, right in
                hypot(left.1.midX - inputCenter.x, left.1.midY - inputCenter.y)
                    < hypot(right.1.midX - inputCenter.x, right.1.midY - inputCenter.y)
            }?
            .0
    }

    private func waitsForComposerSendButton(near input: AXUIElement) -> AXUIElement? {
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            if let button = composerSendButton(near: input) { return button }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return composerSendButton(near: input)
    }

    private func assistantCopyButtons() -> [AXUIElement] {
        let elements = descendants(of: application)
        let shareFrames = elements.filter { isButton($0, containing: "share") }.compactMap { frame(of: $0) }
        // ChatGPT's virtualized controls have unstable frames, but its message
        // headings remain in chronological accessibility-tree order. The final
        // heading is therefore the authoritative latest-message boundary.
        guard let latestMessageIndex = elements.lastIndex(where: isMessageHeading),
              isAssistantMessageHeading(elements[latestMessageIndex]) else {
            return []
        }
        let candidates = elements.enumerated()
            .filter { $0.offset > latestMessageIndex && isPlainCopyButton($0.element) }
            .compactMap { candidate in frame(of: candidate.element).map { (candidate.offset, candidate.element, $0) } }
            .filter { copy in
                shareFrames.contains { share in
                    share.minX > copy.2.maxX && share.minX - copy.2.maxX < 80 && abs(share.midY - copy.2.midY) < 30
                }
            }
            .sorted { $0.0 < $1.0 }
        return candidates.map(\.1)
    }

    private func scrollToBottomIfNeeded() {
        guard let button = visibleScrollToBottomButton() else { return }
        // The button is present only while the latest messages are outside the
        // rendered viewport. Its AXPress action is ignored by this ChatGPT build,
        // so hover and click this one explicit control once.
        click(button.1)
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    }

    private func hasVisibleScrollToBottomButton() -> Bool {
        visibleScrollToBottomButton() != nil
    }

    private func visibleScrollToBottomButton() -> (AXUIElement, CGRect)? {
        descendants(of: application)
            .filter(isScrollToBottomButton)
            .compactMap({ button in frame(of: button).map { (button, $0) } })
            .first(where: { $0.1.width > 1 && $0.1.height > 1 })
    }

    private func isPlainCopyButton(_ element: AXUIElement) -> Bool {
        guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole else { return false }
        return buttonLabels(of: element).contains { $0.caseInsensitiveCompare("copy") == .orderedSame }
    }

    private func isUserEditButton(_ element: AXUIElement) -> Bool {
        isButton(element, containing: "edit message")
    }

    private func isScrollToBottomButton(_ element: AXUIElement) -> Bool {
        guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole else { return false }
        return buttonLabels(of: element).contains { $0.caseInsensitiveCompare("Scroll to bottom") == .orderedSame }
    }

    private func isMessageHeading(_ element: AXUIElement) -> Bool {
        isUserMessageHeading(element) || isAssistantMessageHeading(element)
    }

    private func isUserMessageHeading(_ element: AXUIElement) -> Bool {
        isHeading(element, titled: "You said:")
    }

    private func isAssistantMessageHeading(_ element: AXUIElement) -> Bool {
        isHeading(element, titled: "ChatGPT said:")
    }

    private func isHeading(_ element: AXUIElement, titled title: String) -> Bool {
        stringAttribute(kAXRoleAttribute, of: element) == kAXHeadingRole
            && stringAttribute(kAXTitleAttribute, of: element)?.caseInsensitiveCompare(title) == .orderedSame
    }

    private func frame(of element: AXUIElement) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue,
              let sizeValue else { return nil }
        let positionAXValue = positionValue as! AXValue
        let sizeAXValue = sizeValue as! AXValue
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionAXValue, .cgPoint, &position),
              AXValueGetValue(sizeAXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: position, size: size)
    }

    private func click(_ frame: CGRect) {
        let source = CGEventSource(stateID: .hidSystemState)
        let center = CGPoint(x: frame.midX, y: frame.midY)
        let originalLocation = CGEvent(source: nil)?.location
        defer {
            if Self.restoresPointerAfterClick, let originalLocation {
                CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: originalLocation, mouseButton: .left)?.post(tap: .cghidEventTap)
            }
        }
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
        // Electron overlays may not accept a click until their hover state has
        // been processed, notably the Scroll to bottom affordance.
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    private func clipboardText(after changeCount: Int, in pasteboard: NSPasteboard) -> String? {
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline {
            if pasteboard.changeCount != changeCount, let text = pasteboard.string(forType: .string) {
                return text
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return nil
    }

    private func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }



}

private struct ChatControl {
    let title: String
    let element: AXUIElement
}

private struct ClipboardSnapshot {
    private let items: [NSPasteboardItem]

    static func capture() -> Self {
        let copies = (NSPasteboard.general.pasteboardItems ?? []).map { original in
            let copy = NSPasteboardItem()
            for type in original.types {
                if let data = original.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
        return Self(items: copies)
    }

    func restore() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }
}

private struct FocusSnapshot {
    let application: NSRunningApplication?
    let element: AXUIElement?

    static func capture() -> Self {
        let application = NSWorkspace.shared.frontmostApplication
        guard let application else { return Self(application: nil, element: nil) }
        let axApplication = AXUIElementCreateApplication(application.processIdentifier)
        var focusedElement: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(axApplication, kAXFocusedUIElementAttribute as CFString, &focusedElement)
        let element: AXUIElement?
        if result == .success, let focusedElement {
            element = (focusedElement as! AXUIElement)
        } else {
            element = nil
        }
        return Self(application: application, element: element)
    }

    func restore() {
        application?.activate(options: [])
        if let element {
            AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        }
    }
}
