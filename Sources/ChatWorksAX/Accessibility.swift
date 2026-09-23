import AppKit
import ApplicationServices

public enum AccessibilityError: LocalizedError {
  case accessibilityPermissionMissing
  case chatGPTNotRunning
  case multipleChatGPTApplicationsRunning([String])
  case inputNotFound
  case composerBusy
  case composerUnavailable
  case writeFailed(String, AXError)
  case copyControlNotFound
  case assistantMessageNotFound
  case sendNotConfirmed
  case stagedDraftCouldNotBeRestored
  case stagedDraftMismatch(expected: String, observed: [String])
  case newChatControlNotFound
  case chatModeControlNotFound
  case chatNotFound(String)
  case ambiguousChatName(String)
  case renameControlNotFound
  case renameNotConfirmed(String)
  case clipboardDidNotChange
  case interactionRequiresFocus
  case interactionRequiresPointer

  public var errorDescription: String? {
    switch self {
    case .accessibilityPermissionMissing:
      return "Accessibility permission is required for the invoking terminal."
    case .chatGPTNotRunning:
      return "ChatGPT is not running."
    case .multipleChatGPTApplicationsRunning(let identifiers):
      return
        "More than one supported ChatGPT application is running "
        + "(\(identifiers.joined(separator: ", "))). Select one explicitly."
    case .inputNotFound:
      return "Could not find an editable ChatGPT input."
    case .composerBusy:
      return "ChatGPT composer is busy."
    case .composerUnavailable:
      return "ChatGPT composer is temporarily unavailable."
    case .writeFailed(let operation, let error):
      return "Could not \(operation): \(error.rawValue)."
    case .copyControlNotFound:
      return "Could not find a ChatGPT message Copy control."
    case .assistantMessageNotFound:
      return "Could not find a ChatGPT assistant message."
    case .sendNotConfirmed:
      return "ChatGPT did not confirm that the draft was submitted."
    case .stagedDraftCouldNotBeRestored:
      return
        "ChatWorks staged a draft but could not safely restore the composer after submission failed."
    case .stagedDraftMismatch(let expected, let observed):
      let expectedDescription = String(reflecting: expected)
      let observedDescription = observed.map(String.init(reflecting:)).joined(separator: ", ")
      return
        "ChatGPT normalized the staged draft; expected \(expectedDescription); observed [\(observedDescription)]."
    case .newChatControlNotFound:
      return "Could not find ChatGPT's New chat control."
    case .chatModeControlNotFound:
      return "Could not find ChatGPT's Chat/Work mode control."
    case .chatNotFound(let reference):
      return "Could not find a ChatGPT chat matching '\(reference)'."
    case .ambiguousChatName(let name):
      return "More than one ChatGPT chat is named '\(name)'; use its displayed index."
    case .renameControlNotFound:
      return "Could not find ChatGPT's Rename or Save control."
    case .renameNotConfirmed(let title):
      return "ChatGPT did not confirm the renamed chat '\(title)'."
    case .clipboardDidNotChange:
      return "ChatGPT did not place copied message contents on the clipboard."
    case .interactionRequiresFocus:
      return
        "This ChatGPT control requires focus. Retry with --interaction focus or --interaction pointer."
    case .interactionRequiresPointer:
      return "This ChatGPT control requires pointer input. Retry with --interaction pointer."
    }
  }
}

public struct AnyEncodableValue: Encodable {
  private let encodeValue: (Encoder) throws -> Void

  public init<T: Encodable>(_ value: T) {
    encodeValue = { encoder in
      var container = encoder.singleValueContainer()
      try container.encode(value)
    }
  }

  public func encode(to encoder: Encoder) throws {
    try encodeValue(encoder)
  }
}

public struct ChatReference: Encodable {
  public let index: Int
  public let title: String
}

public struct AssistantMessageState: Encodable {
  public let responseHeadingCount: Int
  public let scrollToBottomVisible: Bool
}

public enum ComposerAvailability: String, Encodable {
  case available
  case busy
  case unavailable
}

public struct ComposerState: Encodable {
  public let availability: ComposerAvailability
}

public enum GuardedSubmissionStatus: String, Encodable {
  case submitted
  case busy
  case unavailable
}

public enum InteractionPolicy: String {
  case background
  case focus
  case pointer

  var allowsFocus: Bool { self == .focus || self == .pointer }
  var allowsPointer: Bool { self == .pointer }
}

public struct GuardedSubmissionResult: Encodable {
  public let status: GuardedSubmissionStatus
}

public struct AccessibilityAssistantObservation: Encodable {
  public let latestMessageRole: String?
  public let parts: [AccessibilityMessagePart]
}

private struct ComposerSnapshot: Equatable {
  let inputExists: Bool
  let text: String?
  let isEmpty: Bool
  let sendPresent: Bool
  let stopPresent: Bool
  let pastedTextAttachmentPresent: Bool

  var diagnosticDescription: String {
    let textDescription: String
    if let text {
      textDescription = "textChars=\(text.count)"
    } else {
      textDescription = "text=nil"
    }

    return [
      "input=\(inputExists)",
      textDescription,
      "empty=\(isEmpty)",
      "send=\(sendPresent)",
      "stop=\(stopPresent)",
      "attachment=\(pastedTextAttachmentPresent)",
    ].joined(separator: " ")
  }
}

private enum StageAssessment {
  case processing
  case acceptedAsExactText
  case acceptedAsTransformedText
  case acceptedAsAttachment
}

public struct ChatGPTAccessibility {
  let application: AXUIElement
  private let previousFocus: FocusSnapshot
  private let interactionState = InteractionState()
  private let interactionPolicy: InteractionPolicy
  private let requiresChatMode: Bool
  private let classicAccessibilityReader: ClassicAccessibilityReader?
  private static let supportedBundleIdentifiers = ["com.openai.codex", "com.openai.chat"]
  // Physical clicks are compatibility fallbacks for controls whose semantic
  // AX actions are ineffective. Never leave the user's pointer at the
  // synthetic interaction location.
  private static let restoresPointerAfterClick = true

  public static func connect(
    bundleIdentifier: String? = nil,
    interactionPolicy: InteractionPolicy = .background
  ) throws -> Self {
    guard AXIsProcessTrusted() else { throw AccessibilityError.accessibilityPermissionMissing }
    let previousFocus = FocusSnapshot.capture()
    let running = NSWorkspace.shared.runningApplications.filter { application in
      guard let identifier = application.bundleIdentifier else { return false }
      return bundleIdentifier.map { $0 == identifier }
        ?? supportedBundleIdentifiers.contains(identifier)
    }

    guard !running.isEmpty else { throw AccessibilityError.chatGPTNotRunning }
    guard running.count == 1, let application = running.first else {
      throw AccessibilityError.multipleChatGPTApplicationsRunning(
        running.compactMap(\.bundleIdentifier).sorted()
      )
    }

    return Self(
      application: AXUIElementCreateApplication(application.processIdentifier),
      previousFocus: previousFocus,
      interactionPolicy: interactionPolicy,
      requiresChatMode: application.bundleIdentifier != "com.openai.chat",
      classicAccessibilityReader: application.bundleIdentifier == "com.openai.chat"
        ? ClassicAccessibilityReader(
          application: AXUIElementCreateApplication(application.processIdentifier))
        : nil
    )
  }

  public func restoreFocus() {
    guard interactionState.didTakeFocus else { return }
    previousFocus.restore()
  }

  public func inspector() -> ChatGPTAccessibilityInspector {
    ChatGPTAccessibilityInspector(application: application)
  }

  public func latestAssistantObservation() throws -> AccessibilityAssistantObservation {
    let structure = AccessibilityMessageStructure(application: application)
    let payloads = structure.payloads()

    guard let latest = structure.latestMessagePayload(from: payloads) else {
      return try latestClassicAccessibilityObservation()
    }

    let role = structure.role(of: latest)
    let parts =
      role == "assistant"
      ? AccessibilityMessagePartReader().read(latest)
      : []

    return AccessibilityAssistantObservation(
      latestMessageRole: role,
      parts: parts
    )
  }

  public func latestAssistantParts() throws -> [AccessibilityMessagePart] {
    try latestAssistantObservation().parts
  }

  public func latestAssistantRawText() throws -> String {
    guard let copyButton = assistantCopyButtons().first else {
      return try latestClassicAccessibilityRawText()
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
    let changeCount = pasteboard.changeCount
    let result = AXUIElementPerformAction(copyButton, kAXPressAction as CFString)
    guard result == .success else {
      throw AccessibilityError.writeFailed("press ChatGPT Copy", result)
    }
    guard let text = clipboardText(after: changeCount, in: pasteboard) else {
      throw AccessibilityError.clipboardDidNotChange
    }
    return text
  }

  public func assistantMessageState() -> AssistantMessageState {
    if let classicAccessibilityReader, !classicAccessibilityReader.latestParts().isEmpty {
      return AssistantMessageState(
        responseHeadingCount: 1,
        scrollToBottomVisible: hasVisibleScrollToBottomButton()
      )
    }
    return AssistantMessageState(
      responseHeadingCount: descendants(of: application).count(where: isAssistantMessageHeading),
      scrollToBottomVisible: hasVisibleScrollToBottomButton()
    )
  }

  private func latestClassicAccessibilityObservation() throws -> AccessibilityAssistantObservation {
    guard let classicAccessibilityReader else {
      throw AccessibilityError.assistantMessageNotFound
    }
    let parts = classicAccessibilityReader.latestParts()
    guard !parts.isEmpty else { throw AccessibilityError.assistantMessageNotFound }
    return AccessibilityAssistantObservation(latestMessageRole: "assistant", parts: parts)
  }

  private func latestClassicAccessibilityRawText() throws -> String {
    let parts = try latestClassicAccessibilityObservation().parts
    return parts.compactMap { part in
      guard part.kind == "code", let source = part.source else { return nil }
      return "```\(part.language ?? "")\n\(source)\n```"
    }.joined(separator: "\n\n")
  }

  public func scrollToBottom() throws {
    try scrollToBottomIfNeeded()
  }

  public func composerState() -> ComposerState {
    let snapshot = composerSnapshot()

    guard snapshot.inputExists else {
      return ComposerState(availability: .unavailable)
    }

    // Stop takes precedence during transient captures that expose controls
    // from both composer states.
    if snapshot.stopPresent {
      return ComposerState(availability: .busy)
    }

    if snapshot.sendPresent {
      return ComposerState(availability: .available)
    }

    return ComposerState(availability: .unavailable)
  }

  private func typeDraft(_ text: String) throws -> [NSPasteboardItem]? {
    guard let input = waitsForEditableInput() else {
      throw AccessibilityError.inputNotFound
    }

    // Setting a writable AX value does not require activation, focus, or
    // synthetic keyboard input. Prefer it for the normal background path.
    let valueResult = AXUIElementSetAttributeValue(
      input,
      kAXValueAttribute as CFString,
      text as CFTypeRef
    )
    if valueResult == .success {
      return nil
    }

    guard interactionPolicy.allowsFocus else {
      throw AccessibilityError.interactionRequiresFocus
    }

    let focusResult = AXUIElementSetAttributeValue(
      input,
      kAXFocusedAttribute as CFString,
      kCFBooleanTrue
    )
    guard focusResult == .success else {
      throw AccessibilityError.writeFailed("focus ChatGPT composer", focusResult)
    }
    interactionState.didTakeFocus = true

    let pasteboard = NSPasteboard.general
    let previousItems =
      pasteboard.pasteboardItems?.compactMap { item -> NSPasteboardItem? in
        let copy = NSPasteboardItem()
        var copied = false
        for type in item.types {
          if let data = item.data(forType: type) {
            copy.setData(data, forType: type)
            copied = true
          }
        }
        return copied ? copy : nil
      } ?? []

    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)

    let keySource = CGEventSource(stateID: .hidSystemState)
    let keyDown = CGEvent(
      keyboardEventSource: keySource,
      virtualKey: 9,
      keyDown: true
    )
    let keyUp = CGEvent(
      keyboardEventSource: keySource,
      virtualKey: 9,
      keyDown: false
    )
    keyDown?.flags = .maskCommand
    keyUp?.flags = .maskCommand
    keyDown?.post(tap: .cghidEventTap)
    keyUp?.post(tap: .cghidEventTap)

    return previousItems
  }

  private func restorePasteboard(_ previousItems: [NSPasteboardItem]) {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    if !previousItems.isEmpty {
      pasteboard.writeObjects(previousItems)
    }
  }

  private func clearComposerContents() throws {
    guard let input = waitsForEditableInput() else {
      throw AccessibilityError.inputNotFound
    }

    let result = AXUIElementSetAttributeValue(
      input,
      kAXValueAttribute as CFString,
      "" as CFTypeRef
    )
    guard result == .success else {
      throw AccessibilityError.writeFailed(
        "clear ChatGPT composer",
        result
      )
    }

    // AX assignment and ChatGPT's web editor are asynchronous. Do not treat
    // successful AX mutation as a confirmed empty editor; observe the
    // resulting semantic state instead.
    let deadline = Date().addingTimeInterval(3)

    while Date() < deadline {
      let snapshot = composerSnapshot()

      if snapshot.inputExists,
        snapshot.isEmpty,
        !snapshot.pastedTextAttachmentPresent
      {
        return
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    throw AccessibilityError.writeFailed(
      "confirm empty ChatGPT composer",
      .failure
    )
  }

  private func composerPastedTextAttachments(
    near input: AXUIElement,
    elements: [AXUIElement]? = nil
  ) -> [AXUIElement] {
    guard let inputFrame = frame(of: input) else {
      return []
    }

    return (elements ?? descendants(of: application)).filter { element in
      guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole,
        let elementFrame = frame(of: element)
      else {
        return false
      }

      let labels = controlLabels(of: element)
      guard
        labels.contains(where: {
          $0.caseInsensitiveCompare("Pasted text.txt") == .orderedSame
        })
      else {
        return false
      }

      // Composer attachments occupy the local region immediately above the
      // editable input. Historical message attachments elsewhere in the
      // virtualized AX tree must not satisfy staging.
      return elementFrame.maxX >= inputFrame.minX
        && elementFrame.minX <= inputFrame.maxX
        && elementFrame.maxY >= inputFrame.minY - 160
        && elementFrame.minY <= inputFrame.maxY
    }
  }

  private func composerSnapshot() -> ComposerSnapshot {
    let elements = descendants(of: application)

    guard let input = composerInput(in: elements) else {
      return ComposerSnapshot(
        inputExists: false,
        text: nil,
        isEmpty: false,
        sendPresent: false,
        stopPresent: false,
        pastedTextAttachmentPresent: false
      )
    }

    return composerSnapshot(of: input, elements: elements)
  }

  private func composerSnapshot(
    of input: AXUIElement,
    elements: [AXUIElement]? = nil
  ) -> ComposerSnapshot {
    let elements = elements ?? descendants(of: application)
    let text = stringAttribute(kAXValueAttribute, of: input)

    let nearbyButtons: [(AXUIElement, CGRect)]
    if let inputFrame = frame(of: input) {
      let inputCenter = CGPoint(x: inputFrame.midX, y: inputFrame.midY)
      nearbyButtons =
        elements
        .filter {
          stringAttribute(kAXRoleAttribute, of: $0) == kAXButtonRole
        }
        .compactMap { button in
          frame(of: button).map { (button, $0) }
        }
        .filter { _, buttonFrame in
          let dx = buttonFrame.midX - inputCenter.x
          let dy = buttonFrame.midY - inputCenter.y
          return abs(dx) <= inputFrame.width / 2 + 180
            && abs(dy) <= inputFrame.height / 2 + 120
        }
    } else {
      nearbyButtons = []
    }

    let sendPresent = sendControl(for: input, elements: elements) != nil
    let stopPresent = nearbyButtons.contains { button, _ in
      isButton(button, containing: "stop")
    }

    let attachmentPresent =
      composerPastedTextAttachments(
        near: input,
        elements: elements
      )
      .contains { attachment in
        guard let attachmentFrame = frame(of: attachment) else {
          return false
        }
        return attachmentFrame.width > 1 && attachmentFrame.height > 1
      }

    return ComposerSnapshot(
      inputExists: true,
      text: text,
      isEmpty: isEmptyComposer(input),
      sendPresent: sendPresent,
      stopPresent: stopPresent,
      pastedTextAttachmentPresent: attachmentPresent
    )
  }

  private func stagingTextDifference(
    observed: String?,
    intended: String
  ) -> String {
    guard let observed else {
      return "observed=nil"
    }

    let normalizedObserved = normalizedComposerText(
      observed.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    let normalizedIntended = normalizedComposerText(
      intended.trimmingCharacters(in: .whitespacesAndNewlines)
    )

    let observedCharacters = Array(normalizedObserved)
    let intendedCharacters = Array(normalizedIntended)
    let commonCount = min(observedCharacters.count, intendedCharacters.count)

    var firstDifference = commonCount
    for index in 0..<commonCount {
      if observedCharacters[index] != intendedCharacters[index] {
        firstDifference = index
        break
      }
    }

    if firstDifference == commonCount && observedCharacters.count == intendedCharacters.count {
      return "normalized-equal"
    }

    let lower = max(0, firstDifference - 20)
    let observedUpper = min(observedCharacters.count, firstDifference + 40)
    let intendedUpper = min(intendedCharacters.count, firstDifference + 40)

    func escaped(_ characters: ArraySlice<Character>) -> String {
      String(characters)
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
    }

    return [
      "observedChars=\(observedCharacters.count)",
      "intendedChars=\(intendedCharacters.count)",
      "firstDiff=\(firstDifference)",
      "observed=\"\(escaped(observedCharacters[lower..<observedUpper]))\"",
      "intended=\"\(escaped(intendedCharacters[lower..<intendedUpper]))\"",
    ].joined(separator: " ")
  }

  private func assessStage(
    _ snapshot: ComposerSnapshot,
    baseline: ComposerSnapshot,
    intendedText: String
  ) -> StageAssessment {
    guard snapshot.inputExists, snapshot.sendPresent else {
      return .processing
    }

    // Staging owns the composer from the successful clear until this
    // assessment completes. Acceptance is therefore based on a transition
    // away from the known empty baseline, not on AX exposing a lossless
    // serialization of ChatGPT's web editor.
    guard baseline.isEmpty,
      !baseline.pastedTextAttachmentPresent
    else {
      return .processing
    }

    // ChatGPT exposes placeholder/control-label text such as "Ask ChatGPT"
    // through AXValue even when the composer is semantically empty. Raw
    // non-empty AX text therefore cannot establish inline staging.
    if !snapshot.isEmpty,
      let observedText = snapshot.text
    {
      let trimmedObserved = observedText.trimmingCharacters(
        in: .whitespacesAndNewlines
      )

      if !trimmedObserved.isEmpty {
        let normalizedObserved = normalizedComposerText(trimmedObserved)
        let normalizedIntended = normalizedComposerText(
          intendedText.trimmingCharacters(in: .whitespacesAndNewlines)
        )

        if normalizedObserved == normalizedIntended {
          return .acceptedAsExactText
        }

        return .acceptedAsTransformedText
      }
    }

    if snapshot.pastedTextAttachmentPresent {
      return .acceptedAsAttachment
    }

    return .processing
  }

  public func stage(_ text: String) throws {
    guard waitsForEditableInput() != nil else {
      throw AccessibilityError.inputNotFound
    }

    try clearComposerContents()

    let baseline = composerSnapshot()
    let previousPasteboardItems = try typeDraft(text)
    defer {
      if let previousPasteboardItems {
        restorePasteboard(previousPasteboardItems)
      }
    }

    // Paste processing is asynchronous for every payload. ChatGPT may expose
    // the accepted payload as editor-normalized inline text or materialize it
    // as an attachment. Do not predict the representation from payload size.
    // Acceptance requires a sendable post-paste transition from the known
    // empty composer baseline.
    let deadline = Date().addingTimeInterval(10)

    let startedAt = Date()
    var lastSnapshot: ComposerSnapshot?
    var transitions: [String] = []

    while Date() < deadline {
      let snapshot = composerSnapshot()

      if snapshot != lastSnapshot {
        let elapsed = Date().timeIntervalSince(startedAt)
        transitions.append(
          String(format: "%.2fs %@", elapsed, snapshot.diagnosticDescription)
        )
        lastSnapshot = snapshot
      }

      switch assessStage(
        snapshot,
        baseline: baseline,
        intendedText: text
      ) {
      case .acceptedAsExactText, .acceptedAsAttachment:
        return
      case .acceptedAsTransformedText:
        fputs(
          "chatworks-ax: staged inline text was normalized by ChatGPT:\n  "
            + stagingTextDifference(
              observed: snapshot.text,
              intended: text
            ) + "\n",
          stderr
        )
        return
      case .processing:
        break
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    let finalSnapshot = composerSnapshot()
    fputs(
      "chatworks-ax: staged text comparison:\n  "
        + stagingTextDifference(
          observed: finalSnapshot.text,
          intended: text
        ) + "\n",
      stderr
    )

    fputs(
      "chatworks-ax: staging transition history:\n" + transitions.map { "  \($0)\n" }.joined(),
      stderr
    )

    throw AccessibilityError.writeFailed(
      "verify staged ChatGPT draft or attachment",
      .failure
    )
  }

  public func guardedStageAndSend(
    _ text: String
  ) throws -> GuardedSubmissionResult {
    // Only pre-mutation availability is safely retryable. Once staging begins,
    // any failure propagates because the operation may already have mutated
    // ChatGPT's composer or conversation.
    switch composerState().availability {
    case .busy:
      return GuardedSubmissionResult(status: .busy)
    case .unavailable:
      return GuardedSubmissionResult(status: .unavailable)
    case .available:
      break
    }

    try stageAndSendAfterAvailabilityCheck(text)
    return GuardedSubmissionResult(status: .submitted)
  }

  public func stageAndSend(_ text: String) throws {
    switch composerState().availability {
    case .available:
      break
    case .busy:
      throw AccessibilityError.composerBusy
    case .unavailable:
      throw AccessibilityError.composerUnavailable
    }

    try stageAndSendAfterAvailabilityCheck(text)
  }

  private func stageAndSendAfterAvailabilityCheck(_ text: String) throws {
    try stage(text)

    // Keep ChatGPT frontmost through the synthetic Enter used by send().
    // send() restores the user's previous focus only after the conversation
    // confirms that the draft was committed.
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))

    try send()
  }

  public func chatReferences() -> [ChatReference] {
    chatControls().enumerated().map { offset, control in
      ChatReference(index: offset + 1, title: control.title)
    }
  }

  public func chatControlAttributeDiagnostics() -> [[String: AnyEncodableValue]] {
    chatControls().enumerated().map { offset, control in
      [
        "index": AnyEncodableValue(offset + 1),
        "title": AnyEncodableValue(control.title),
        "titleElement": AnyEncodableValue(attributeDiagnostics(of: control.element)),
        "actionElement": AnyEncodableValue(
          control.actionElement.map { attributeDiagnostics(of: $0) } ?? [:]
        ),
        "ancestors": AnyEncodableValue(
          ancestorAttributeDiagnostics(of: control.element)
        ),
      ]
    }
  }

  private func ancestorAttributeDiagnostics(
    of element: AXUIElement,
    limit: Int = 8
  ) -> [[String: String]] {
    var result: [[String: String]] = []
    var current = element

    for _ in 0..<limit {
      var parentValue: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          current,
          kAXParentAttribute as CFString,
          &parentValue
        ) == .success,
        let parentValue
      else {
        break
      }

      let parent = parentValue as! AXUIElement
      result.append(attributeDiagnostics(of: parent))
      current = parent
    }

    return result
  }

  private func attributeDiagnostics(of element: AXUIElement) -> [String: String] {
    var names: CFArray?
    guard AXUIElementCopyAttributeNames(element, &names) == .success,
      let attributes = names as? [String]
    else {
      return [:]
    }

    var result: [String: String] = [:]

    for attribute in attributes {
      var value: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          element,
          attribute as CFString,
          &value
        ) == .success,
        let value
      else {
        continue
      }

      if let string = value as? String {
        result[attribute] = string
      } else if let number = value as? NSNumber {
        result[attribute] = number.stringValue
      } else if CFGetTypeID(value) == AXValueGetTypeID() {
        result[attribute] = String(describing: value)
      }
    }

    return result
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
    let result = AXUIElementPerformAction(selected.element, kAXPressAction as CFString)
    if result == .success { return }
    guard interactionPolicy.allowsPointer, let selectedFrame = frame(of: selected.element) else {
      throw AccessibilityError.writeFailed("select ChatGPT chat", result)
    }
    try click(selectedFrame)
  }

  private func chatControls() -> [ChatControl] {
    let elements = descendants(of: application)
    if !requiresChatMode {
      return classicChatControls(in: elements)
    }

    var controls: [ChatControl] = []
    for (index, element) in elements.enumerated() where isChatActionControl(element) {
      let nearby = elements[max(0, index - 4)..<index].reversed()
      guard let titleControl = nearby.compactMap(chatControl).first,
        !["recents", "show more"].contains(titleControl.title.lowercased())
      else { continue }
      controls.append(
        ChatControl(
          title: titleControl.title,
          element: titleControl.element,
          actionElement: element
        )
      )
    }
    return controls
  }

  private func classicChatControls(in elements: [AXUIElement]) -> [ChatControl] {
    var controls: [ChatControl] = []
    var inRecents = false

    for element in elements {
      if stringAttribute(kAXRoleAttribute, of: element) == kAXHeadingRole,
        controlLabels(of: element).contains(where: {
          $0.caseInsensitiveCompare("Recents") == .orderedSame
        })
      {
        inRecents = true
        continue
      }

      guard inRecents,
        stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole,
        let title = controlLabels(of: element).first,
        let candidateFrame = frame(of: element),
        candidateFrame.width >= 150,
        candidateFrame.minX < 264,
        isInsideList(element),
        actionNames(of: element).contains("AXShowMenu")
      else { continue }

      controls.append(
        ChatControl(title: title, element: element, actionElement: element)
      )
    }

    return controls
  }

  private func isInsideList(_ element: AXUIElement, limit: Int = 64) -> Bool {
    var current = element

    for _ in 0..<limit {
      var parentValue: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          current,
          kAXParentAttribute as CFString,
          &parentValue
        ) == .success,
        let parentValue
      else { return false }

      let parent = parentValue as! AXUIElement
      if stringAttribute(kAXRoleAttribute, of: parent) == kAXListRole {
        return true
      }
      current = parent
    }

    return false
  }

  private func openRenameChat(_ reference: String) throws {
    let controls = chatControls()
    let selected: ChatControl?

    if let index = Int(reference), controls.indices.contains(index - 1) {
      selected = controls[index - 1]
    } else {
      let matches = controls.filter {
        $0.title.caseInsensitiveCompare(reference) == .orderedSame
      }
      if matches.count > 1 {
        throw AccessibilityError.ambiguousChatName(reference)
      }
      selected = matches.first
    }

    guard let selected else {
      throw AccessibilityError.chatNotFound(reference)
    }
    guard let action = selected.actionElement else {
      throw AccessibilityError.chatNotFound(reference)
    }

    let result = AXUIElementPerformAction(
      action,
      "AXShowMenu" as CFString
    )
    guard result == .success else {
      throw AccessibilityError.writeFailed("open ChatGPT chat actions menu", result)
    }

    RunLoop.current.run(until: Date().addingTimeInterval(0.25))

    guard
      let rename = descendants(of: application).first(where: { element in
        stringAttribute(kAXRoleAttribute, of: element) == kAXMenuItemRole
          && stringAttribute(kAXTitleAttribute, of: element)?
            .caseInsensitiveCompare("Rename") == .orderedSame
      })
    else {
      throw AccessibilityError.chatNotFound("Rename menu item")
    }

    let renameResult = AXUIElementPerformAction(
      rename,
      kAXPressAction as CFString
    )
    guard renameResult == .success else {
      throw AccessibilityError.writeFailed("choose Rename chat action", renameResult)
    }

    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
  }

  public func renameChat(
    _ reference: String,
    newTitle: String
  ) throws {
    try openRenameChat(reference)

    guard !newTitle.isEmpty,
      let source = CGEventSource(stateID: .hidSystemState)
    else {
      throw AccessibilityError.renameNotConfirmed(newTitle)
    }

    // Opening ChatGPT's Rename dialog selects the complete existing title.
    // Electron does not expose that editor as an editable AX element, so
    // replace the selected text through Unicode keyboard events.
    for scalar in newTitle.utf16 {
      var character = UniChar(scalar)

      guard
        let keyDown = CGEvent(
          keyboardEventSource: source,
          virtualKey: 0,
          keyDown: true
        ),
        let keyUp = CGEvent(
          keyboardEventSource: source,
          virtualKey: 0,
          keyDown: false
        )
      else {
        throw AccessibilityError.renameNotConfirmed(newTitle)
      }

      keyDown.keyboardSetUnicodeString(
        stringLength: 1,
        unicodeString: &character
      )
      keyDown.post(tap: .cghidEventTap)

      keyUp.keyboardSetUnicodeString(
        stringLength: 1,
        unicodeString: &character
      )
      keyUp.post(tap: .cghidEventTap)
    }

    RunLoop.current.run(until: Date().addingTimeInterval(0.1))

    // The dialog's button label is exposed through descendants even though
    // Electron does not consistently expose the editor itself.
    let saveDeadline = Date().addingTimeInterval(2)
    var save: AXUIElement?

    while Date() < saveDeadline {
      save = descendants(of: application).first(where: { element in
        stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole
          && controlLabels(of: element).contains(where: {
            $0.caseInsensitiveCompare("Save") == .orderedSame
          })
      })

      if save != nil { break }
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    guard let save else {
      throw AccessibilityError.renameControlNotFound
    }

    var saved = false

    let result = AXUIElementPerformAction(save, kAXPressAction as CFString)
    saved = result == .success
    if !saved, interactionPolicy.allowsPointer, let saveFrame = frame(of: save) {
      try click(saveFrame)
      saved = true
    }

    guard saved else {
      throw AccessibilityError.renameControlNotFound
    }

    // Do not trust the click itself. Rename succeeds only when the sidebar
    // exposes exactly one chat with the requested title.
    let confirmationDeadline = Date().addingTimeInterval(3)

    while Date() < confirmationDeadline {
      let matches = chatControls().filter {
        $0.title.caseInsensitiveCompare(newTitle) == .orderedSame
      }

      if matches.count == 1 {
        return
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    throw AccessibilityError.renameNotConfirmed(newTitle)
  }

  public func newChat() throws {
    let buttons = descendants(of: application)
      .filter(isNewChatButton)
      .compactMap { candidate -> (AXUIElement, CGRect)? in
        guard let candidateFrame = frame(of: candidate) else { return nil }
        return (candidate, candidateFrame)
      }
    guard let button = buttons.max(by: { $0.1.width * $0.1.height < $1.1.width * $1.1.height })
    else {
      throw AccessibilityError.newChatControlNotFound
    }
    let result = AXUIElementPerformAction(button.0, kAXPressAction as CFString)
    if result != .success {
      guard interactionPolicy.allowsPointer else {
        throw AccessibilityError.writeFailed("press ChatGPT New chat", result)
      }
      try click(button.1)
    }
    guard requiresChatMode else {
      // ChatGPT Classic has no Chat/Work control. Its independent composer is
      // the available continuation point after a New chat action.
      guard waitsForEditableInput() != nil else {
        throw AccessibilityError.inputNotFound
      }
      return
    }

    // ChatGPT retains old message controls in its virtualized AX tree, so their
    // presence cannot confirm a new-chat transition. The mode control does.
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    do {
      try activateChatMode()
      return
    } catch {
      guard interactionPolicy.allowsPointer else { throw error }
    }

    // This build reports AXPress success without opening a new chat. The
    // prior semantic attempt and missing mode transition make this single
    // physical click an explicit, last-resort compatibility fallback.
    try click(button.1)
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
    try activateChatMode()
  }

  public func submitStagedBySendControl() throws {
    guard let input = waitsForEditableInput(),
      let sendControl = sendControl(for: input)
    else {
      throw AccessibilityError.inputNotFound
    }

    let result = AXUIElementPerformAction(sendControl.element, kAXPressAction as CFString)
    guard result == .success else {
      throw AccessibilityError.writeFailed("press ChatGPT Send", result)
    }
  }

  private func sendControl(
    for input: AXUIElement,
    elements: [AXUIElement]? = nil
  ) -> (element: AXUIElement, frame: CGRect)? {
    let elements = elements ?? descendants(of: application)
    let sendButtons =
      elements
      .filter { isSendButton($0) }
      .compactMap { button -> (AXUIElement, CGRect)? in
        guard let buttonFrame = frame(of: button) else {
          return nil
        }
        return (button, buttonFrame)
      }

    if let inputFrame = frame(of: input) {
      let inputCenter = CGPoint(x: inputFrame.midX, y: inputFrame.midY)
      let candidates = sendButtons.filter { _, buttonFrame in
        let dx = buttonFrame.midX - inputCenter.x
        let dy = buttonFrame.midY - inputCenter.y
        return abs(dx) <= inputFrame.width / 2 + 180
          && abs(dy) <= inputFrame.height / 2 + 120
      }
      if candidates.count == 1 { return candidates[0] }
    }

    // At its minimum window size Classic can retain a usable AX editor while
    // reporting an unusable WebView frame. Its uniquely labelled Send control
    // remains a safe semantic pairing in that layout.
    guard !requiresChatMode, sendButtons.count == 1 else { return nil }
    return sendButtons[0]
  }

  public func submitStagedUnconfirmed() throws {
    guard let input = waitsForEditableInput() else {
      throw AccessibilityError.inputNotFound
    }

    let staged = composerSnapshot(of: input)

    guard staged.inputExists,
      !staged.isEmpty || staged.pastedTextAttachmentPresent
    else {
      throw AccessibilityError.sendNotConfirmed
    }

    try submitStaged(input: input)
  }

  public func send() throws {
    guard let input = waitsForEditableInput() else {
      throw AccessibilityError.inputNotFound
    }

    let staged = composerSnapshot(of: input)

    // stage() has already established sendability. Enter-based submission
    // operates on the staged composer itself and does not use the Send
    // control, whose presence may change asynchronously between observations.
    guard staged.inputExists,
      !staged.isEmpty || staged.pastedTextAttachmentPresent
    else {
      throw AccessibilityError.sendNotConfirmed
    }

    let beforeStructure = AccessibilityMessageStructure(application: application)
    let beforePayloads = beforeStructure.payloads()
    let beforeLatest = beforeStructure.latestMessagePayload(from: beforePayloads)

    let beforeAssistantFingerprint: String?
    if let beforeLatest {
      guard beforeStructure.role(of: beforeLatest) == "assistant" else {
        throw AccessibilityError.sendNotConfirmed
      }
      beforeAssistantFingerprint =
        beforeStructure.semanticFingerprint(of: beforeLatest)
    } else {
      beforeAssistantFingerprint = nil
    }

    try submitStaged(input: input)

    let submitted = waitsForSendSubmission(
      afterAssistantFingerprint: beforeAssistantFingerprint,
      staged: staged,
      input: input
    )

    guard submitted else {
      throw AccessibilityError.sendNotConfirmed
    }
  }

  private func submitStaged(input: AXUIElement) throws {
    let staged = composerSnapshot(of: input)

    try submitStagedBySendControl()

    if waitsForDraftConsumption(staged, input: input) { return }

    guard interactionPolicy.allowsFocus else {
      throw AccessibilityError.interactionRequiresFocus
    }

    let focusResult = AXUIElementSetAttributeValue(
      input,
      kAXFocusedAttribute as CFString,
      kCFBooleanTrue
    )
    guard focusResult == .success else {
      throw AccessibilityError.writeFailed(
        "focus ChatGPT composer",
        focusResult
      )
    }
    interactionState.didTakeFocus = true

    let keySource = CGEventSource(stateID: .hidSystemState)
    CGEvent(
      keyboardEventSource: keySource,
      virtualKey: 36,
      keyDown: true
    )?.post(tap: .cghidEventTap)
    CGEvent(
      keyboardEventSource: keySource,
      virtualKey: 36,
      keyDown: false
    )?.post(tap: .cghidEventTap)

    if waitsForDraftConsumption(staged, input: input) { return }

    guard interactionPolicy.allowsPointer,
      let sendControl = sendControl(for: input)
    else {
      throw AccessibilityError.interactionRequiresPointer
    }

    try click(sendControl.frame)
  }

  private func waitsForDraftConsumption(
    _ staged: ComposerSnapshot,
    input: AXUIElement
  ) -> Bool {
    let deadline = Date().addingTimeInterval(0.35)
    while Date() < deadline {
      let composer = composerSnapshot(of: input)
      if composer.text == nil || composer.isEmpty || composer.text != staged.text {
        return true
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    return false
  }

  private func normalizedComposerText(_ text: String) -> String {
    text.replacingOccurrences(
      of: #"```\n[ \t]*\n```"#,
      with: "```\n```",
      options: .regularExpression
    )
  }

  private func isEditableInput(_ element: AXUIElement) -> Bool {
    guard let role = stringAttribute(kAXRoleAttribute, of: element),
      role == kAXTextAreaRole || role == kAXTextFieldRole
    else { return false }
    return isValueAttributeSettable(of: element)
  }

  private func editableInput() -> AXUIElement? {
    composerInput(in: descendants(of: application))
  }

  private func composerInput(in elements: [AXUIElement]) -> AXUIElement? {
    let editableInputs = elements.filter(isEditableInput)
    let candidates = editableInputs.compactMap { element -> (AXUIElement, CGRect)? in
      guard let inputFrame = frame(of: element),
        inputFrame.width > 1, inputFrame.height > 1
      else { return nil }
      return (element, inputFrame)
    }

    if let spatialMatch = candidates.last(where: { _, inputFrame in
      elements.contains { button in
        guard stringAttribute(kAXRoleAttribute, of: button) == kAXButtonRole,
          let buttonFrame = frame(of: button)
        else { return false }
        let dx = buttonFrame.midX - inputFrame.midX
        let dy = buttonFrame.midY - inputFrame.midY
        return abs(dx) <= inputFrame.width / 2 + 180
          && abs(dy) <= inputFrame.height / 2 + 120
          && (isSendButton(button) || isButton(button, containing: "stop"))
      }
    })?.0 {
      return spatialMatch
    }

    guard !requiresChatMode else { return nil }
    let textAreas = editableInputs.filter {
      stringAttribute(kAXRoleAttribute, of: $0) == kAXTextAreaRole
    }
    return textAreas.count == 1 ? textAreas[0] : nil
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
    guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole else { return false }
    return buttonLabels(of: element).contains { label in
      ["Send", "Send message"].contains {
        $0.caseInsensitiveCompare(label) == .orderedSame
      }
    }
  }

  private func isNewChatButton(_ element: AXUIElement) -> Bool {
    guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole else { return false }
    return buttonLabels(of: element).contains {
      $0.caseInsensitiveCompare("new chat") == .orderedSame
    }
  }

  private func activateChatMode() throws {
    guard let chat = waitsForChatModeControl() else {
      throw AccessibilityError.chatModeControlNotFound
    }

    let result = AXUIElementPerformAction(
      chat.element,
      kAXPressAction as CFString
    )

    if result == .success {
      let deadline = Date().addingTimeInterval(0.5)
      while Date() < deadline {
        if let current = chatModeControl(),
          numericAttribute(kAXValueAttribute, of: current.element) == 1
        {
          return
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
      }
    }

    // ChatGPT/Electron may advertise AXPress and even report success without
    // applying the requested UI transition. Fall back to the characterized
    // physical interaction, whose pointer position is restored by click().
    guard let current = chatModeControl() else {
      throw AccessibilityError.chatModeControlNotFound
    }
    try click(current.frame)
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
        guard let label = modeControlLabel(of: element), let frame = frame(of: element) else {
          return nil
        }
        return (element, label, frame)
      }
    let workControls = controls.filter { $0.label.caseInsensitiveCompare("Work") == .orderedSame }
    guard
      let chat =
        controls
        .filter({ $0.label.caseInsensitiveCompare("Chat") == .orderedSame })
        .filter({ candidate in
          workControls.contains { work in
            abs(work.frame.midY - candidate.frame.midY) < 30
              && abs(work.frame.midX - candidate.frame.midX) < 250
          }
        })
        .min(by: { $0.frame.minY < $1.frame.minY })
    else { return nil }
    return (chat.element, chat.frame)
  }

  private func modeControlLabel(of element: AXUIElement) -> String? {
    guard let role = stringAttribute(kAXRoleAttribute, of: element),
      [kAXButtonRole, kAXRadioButtonRole, kAXCheckBoxRole, kAXPopUpButtonRole].contains(role)
    else { return nil }
    return controlLabels(of: element).first { label in
      ["Chat", "Work"].contains { $0.caseInsensitiveCompare(label) == .orderedSame }
    }
  }

  private func isChatActionControl(_ element: AXUIElement) -> Bool {
    guard stringAttribute(kAXRoleAttribute, of: element) == kAXPopUpButtonRole else { return false }
    return controlLabels(of: element).contains {
      $0.localizedCaseInsensitiveContains("chat actions")
    }
  }

  private func chatControl(_ element: AXUIElement) -> ChatControl? {
    guard stringAttribute(kAXRoleAttribute, of: element) == kAXButtonRole,
      let title = stringAttribute(kAXTitleAttribute, of: element), !title.isEmpty
    else { return nil }
    return ChatControl(title: title, element: element, actionElement: nil)
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

  private func actionNames(of element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else {
      return []
    }
    return names as? [String] ?? []
  }

  private func descendants(of root: AXUIElement, limit: Int = 5_000) -> [AXUIElement] {
    var result: [AXUIElement] = []
    var pending = [root]
    while let element = pending.popLast(), result.count < limit {
      result.append(element)
      var children: CFTypeRef?
      if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
        == .success,
        let values = children as? [AXUIElement]
      {
        pending.append(contentsOf: values.reversed())
      }
    }
    return result
  }

  private func waitsForSendSubmission(
    afterAssistantFingerprint assistantFingerprint: String?,
    staged: ComposerSnapshot,
    input: AXUIElement
  ) -> Bool {
    let deadline = Date().addingTimeInterval(3)
    let startedAt = Date()

    var lastComposer: ComposerSnapshot?
    var transitions: [String] = []

    while Date() < deadline {
      let composer = composerSnapshot(of: input)

      if composer != lastComposer {
        let elapsed = Date().timeIntervalSince(startedAt)
        transitions.append(
          String(
            format: "%.2fs composer %@",
            elapsed,
            composer.diagnosticDescription
          )
        )
        lastComposer = composer
      }

      let structure = AccessibilityMessageStructure(application: application)

      // This relation is established within one AX capture. It does not rely
      // on payload counts or traversal indices remaining stable across
      // independent captures.
      let committedUserTurn =
        structure.userPayloadCommittedAfter(
          assistantFingerprint: assistantFingerprint
        ) != nil

      let stagedRepresentationConsumed: Bool
      if staged.pastedTextAttachmentPresent {
        stagedRepresentationConsumed =
          !composer.pastedTextAttachmentPresent
      } else {
        // AXValue may temporarily become unavailable immediately after Enter.
        // Once the corresponding user turn is structurally committed, either
        // an empty composer or an unavailable value proves that the staged
        // text is no longer represented by this input.
        stagedRepresentationConsumed =
          composer.text == nil || composer.isEmpty
      }

      if committedUserTurn && stagedRepresentationConsumed {
        let rediscoveredComposer = composerSnapshot()
        let sequence = structure.diagnosticPayloadSequence()

        fputs(
          "chatworks-ax: send confirmation evidence:\n"
            + "  staged=\(staged.diagnosticDescription)\n"
            + "  sameInput=\(composer.diagnosticDescription)\n"
            + "  rediscovered=\(rediscoveredComposer.diagnosticDescription)\n"
            + "  committedUserTurn=\(committedUserTurn)\n"
            + "  stagedRepresentationConsumed=\(stagedRepresentationConsumed)\n"
            + "  assistantFingerprintChars=\(assistantFingerprint?.count ?? 0)\n"
            + "  payloadSequence=\(sequence.joined(separator: ","))\n",
          stderr
        )

        return true
      }

      // ChatGPT Classic can omit the just-submitted user message from its AX
      // message structure and can keep exposing Send instead of Stop. Draft
      // consumption is direct, composer-local evidence that the staged draft
      // was submitted.
      if stagedRepresentationConsumed {
        return true
      }

      RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }

    let finalComposer = composerSnapshot(of: input)
    let finalStructure = AccessibilityMessageStructure(application: application)
    let finalPayloads = finalStructure.payloads()
    let finalRole =
      finalStructure.latestMessagePayload(from: finalPayloads)
      .flatMap { finalStructure.role(of: $0) } ?? "nil"

    fputs(
      "chatworks-ax: send confirmation timed out:\n" + "  payloadCount=\(finalPayloads.count) "
        + "latestRole=\(finalRole)\n" + "  staged=\(staged.diagnosticDescription)\n"
        + "  final=\(finalComposer.diagnosticDescription)\n"
        + "chatworks-ax: send composer transitions:\n" + transitions.map { "  \($0)\n" }.joined(),
      stderr
    )

    return false
  }

  private func isEmptyComposer(_ input: AXUIElement) -> Bool {
    guard let value = stringAttribute(kAXValueAttribute, of: input) else {
      return false
    }

    // AXValue is content. Only descriptive attributes may identify the
    // placeholder representation of an empty ChatGPT editor.
    let descriptiveLabels = [
      kAXTitleAttribute,
      kAXDescriptionAttribute,
      kAXHelpAttribute,
    ].compactMap {
      stringAttribute($0, of: input)
    }

    return ComposerSemantics.isEmpty(
      value: value,
      descriptiveLabels: descriptiveLabels
    )
  }

  private func assistantCopyButtons() -> [AXUIElement] {
    let elements = descendants(of: application)
    let shareFrames = elements.filter { isButton($0, containing: "share") }.compactMap {
      frame(of: $0)
    }
    // ChatGPT's virtualized controls have unstable frames, but its message
    // headings remain in chronological accessibility-tree order. The final
    // heading is therefore the authoritative latest-message boundary.
    guard let latestMessageIndex = elements.lastIndex(where: isMessageHeading),
      isAssistantMessageHeading(elements[latestMessageIndex])
    else {
      return []
    }
    let candidates = elements.enumerated()
      .filter { $0.offset > latestMessageIndex && isPlainCopyButton($0.element) }
      .compactMap { candidate in
        frame(of: candidate.element).map { (candidate.offset, candidate.element, $0) }
      }
      .filter { copy in
        shareFrames.contains { share in
          share.minX > copy.2.maxX && share.minX - copy.2.maxX < 80
            && abs(share.midY - copy.2.midY) < 30
        }
      }
      .sorted { $0.0 < $1.0 }
    return candidates.map(\.1)
  }

  private func scrollToBottomIfNeeded() throws {
    guard let button = visibleScrollToBottomButton() else { return }
    let result = AXUIElementPerformAction(button.0, kAXPressAction as CFString)
    if result != .success {
      guard interactionPolicy.allowsPointer else {
        throw AccessibilityError.writeFailed("press ChatGPT Scroll to bottom", result)
      }
      try click(button.1)
    }
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
    return buttonLabels(of: element).contains {
      $0.caseInsensitiveCompare("Scroll to bottom") == .orderedSame
    }
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
      && stringAttribute(kAXTitleAttribute, of: element)?.caseInsensitiveCompare(title)
        == .orderedSame
  }

  private func frame(of element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        == .success,
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
      let positionValue,
      let sizeValue
    else { return nil }
    let positionAXValue = positionValue as! AXValue
    let sizeAXValue = sizeValue as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionAXValue, .cgPoint, &position),
      AXValueGetValue(sizeAXValue, .cgSize, &size)
    else { return nil }
    return CGRect(origin: position, size: size)
  }

  private func click(_ frame: CGRect) throws {
    guard interactionPolicy.allowsPointer else {
      throw AccessibilityError.interactionRequiresPointer
    }
    interactionState.didTakeFocus = true
    let source = CGEventSource(stateID: .hidSystemState)
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let originalLocation = CGEvent(source: nil)?.location
    defer {
      if Self.restoresPointerAfterClick, let originalLocation {
        CGEvent(
          mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: originalLocation,
          mouseButton: .left)?.post(tap: .cghidEventTap)
      }
    }
    CGEvent(
      mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: center,
      mouseButton: .left)?.post(tap: .cghidEventTap)
    // Electron overlays may not accept a click until their hover state has
    // been processed, notably the Scroll to bottom affordance.
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    CGEvent(
      mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: center,
      mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(
      mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: center,
      mouseButton: .left)?.post(tap: .cghidEventTap)
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

  private func numericAttribute(
    _ attribute: String,
    of element: AXUIElement
  ) -> Int? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        element,
        attribute as CFString,
        &value
      ) == .success,
      let number = value as? NSNumber
    else {
      return nil
    }
    return number.intValue
  }

  private func isValueAttributeSettable(of element: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(
      element,
      kAXValueAttribute as CFString,
      &settable
    ) == .success && settable.boolValue
  }

  private func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
      return nil
    }
    return value as? String
  }

}

private struct ChatControl {
  let title: String
  let element: AXUIElement
  let actionElement: AXUIElement?
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

private final class InteractionState {
  var didTakeFocus = false
}

private struct FocusSnapshot {
  let application: NSRunningApplication?
  let element: AXUIElement?

  static func capture() -> Self {
    let application = NSWorkspace.shared.frontmostApplication
    guard let application else { return Self(application: nil, element: nil) }
    let axApplication = AXUIElementCreateApplication(application.processIdentifier)
    var focusedElement: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(
      axApplication, kAXFocusedUIElementAttribute as CFString, &focusedElement)
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
