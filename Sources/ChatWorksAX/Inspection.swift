import ApplicationServices
import Foundation

public struct AccessibilityFrame: Encodable {
  public let x: CGFloat
  public let y: CGFloat
  public let width: CGFloat
  public let height: CGFloat
}

public struct AccessibilityControlSnapshot: Encodable {
  public let traversalIndex: Int
  public let role: String?
  public let title: String?
  public let description: String?
  public let value: String?
  public let frame: AccessibilityFrame?
  public let actions: [String]
}

public struct AccessibilityComposerElementSnapshot: Encodable {
  public let traversalIndex: Int
  public let role: String?
  public let title: String?
  public let description: String?
  public let value: String?
  public let frame: AccessibilityFrame?
  public let actions: [String]
  public let enabled: Bool?
  public let focused: Bool?
  public let settableValue: Bool?
}

public struct AccessibilityComposerSnapshot: Encodable {
  public let inputs: [AccessibilityComposerElementSnapshot]
  public let sendControls: [AccessibilityComposerElementSnapshot]
  public let nearbyButtons: [AccessibilityComposerElementSnapshot]
}

public struct AccessibilityPayloadCandidate: Encodable {
  public let anchorLabel: String
  public let anchorTraversalIndex: Int
  public let rootTraversalIndices: [Int]
}

public struct AccessibilityLatestPayloadSelection: Encodable {
  public let anchorLabel: String
  public let anchorTraversalIndex: Int
  public let rootTraversalIndices: [Int]
  public let rootCount: Int
}

public struct AccessibilityMessageSiblingSnapshot: Encodable {
  public let traversalIndex: Int
  public let role: String?
  public let title: String?
  public let description: String?
  public let value: String?
  public let containsRenderedText: Bool
}

/// Read-only diagnostics for adapting ChatWorks to ChatGPT accessibility changes.
public struct ChatGPTAccessibilityInspector {
  private let application: AXUIElement

  init(application: AXUIElement) {
    self.application = application
  }

  public func elementsNear(
    labels: [String],
    padding: CGFloat = 80,
    limit: Int = 5_000
  ) -> [AccessibilityComposerElementSnapshot] {
    let elements = descendants(of: application, limit: limit)

    let anchors = elements.compactMap { element -> AccessibilityFrame? in
      let values = [
        stringAttribute(kAXTitleAttribute, of: element),
        stringAttribute(kAXDescriptionAttribute, of: element),
        stringAttribute(kAXValueAttribute, of: element),
      ].compactMap { $0 }

      guard
        labels.contains(where: { label in
          values.contains {
            $0.caseInsensitiveCompare(label) == .orderedSame
          }
        })
      else {
        return nil
      }

      return frame(of: element)
    }

    guard !anchors.isEmpty else { return [] }

    return elements.enumerated().compactMap { index, element in
      guard let candidate = frame(of: element) else { return nil }

      let isNear = anchors.contains { anchor in
        let region = CGRect(
          x: anchor.x - padding,
          y: anchor.y - padding,
          width: anchor.width + 2 * padding,
          height: anchor.height + 2 * padding
        )
        let candidateRect = CGRect(
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height
        )
        return region.intersects(candidateRect)
      }

      guard isNear else { return nil }

      return AccessibilityComposerElementSnapshot(
        traversalIndex: index,
        role: stringAttribute(kAXRoleAttribute, of: element),
        title: stringAttribute(kAXTitleAttribute, of: element),
        description: stringAttribute(kAXDescriptionAttribute, of: element),
        value: stringAttribute(kAXValueAttribute, of: element),
        frame: candidate,
        actions: actionNames(of: element),
        enabled: booleanAttribute(kAXEnabledAttribute, of: element),
        focused: booleanAttribute(kAXFocusedAttribute, of: element),
        settableValue: isAttributeSettable(kAXValueAttribute, of: element)
      )
    }
  }

  public func editableAndSelectedElements(
    limit: Int = 5_000
  ) -> [[String: String]] {
    descendants(of: application, limit: limit)
      .enumerated()
      .compactMap { index, element in
        let role = stringAttribute(kAXRoleAttribute, of: element)
        let value = stringAttribute(kAXValueAttribute, of: element)
        let selectedText = stringAttribute(
          kAXSelectedTextAttribute,
          of: element
        )
        let valueSettable =
          isAttributeSettable(kAXValueAttribute, of: element) == true
        let selectedTextSettable =
          isAttributeSettable(kAXSelectedTextAttribute, of: element) == true

        var selectedRangeValue: CFTypeRef?
        let hasSelectedRange =
          AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &selectedRangeValue
          ) == .success

        guard
          valueSettable
            || selectedTextSettable
            || selectedText != nil
            || hasSelectedRange
        else {
          return nil
        }

        var result = [
          "index": String(index),
          "role": role ?? "",
          "value": value ?? "",
          "selectedText": selectedText ?? "",
          "valueSettable": String(valueSettable),
          "selectedTextSettable": String(selectedTextSettable),
          "hasSelectedTextRange": String(hasSelectedRange),
          "actions": actionNames(of: element).joined(separator: ","),
        ]

        if let frame = frame(of: element) {
          result["frame"] =
            "\(frame.x),\(frame.y),\(frame.width),\(frame.height)"
        }

        return result
      }
  }

  public func controls(matching labels: [String] = [], limit: Int = 5_000)
    -> [AccessibilityControlSnapshot]
  {
    descendants(of: application, limit: limit)
      .enumerated()
      .map { snapshot(of: $0.element, traversalIndex: $0.offset) }
      .filter { snapshot in
        guard snapshot.actions.contains("AXPress") || snapshot.actions.contains("AXPick") else {
          return false
        }
        guard !labels.isEmpty else {
          return snapshot.title != nil || snapshot.description != nil || snapshot.value != nil
        }
        let values = [snapshot.title, snapshot.description, snapshot.value].compactMap { $0 }
        return labels.contains { label in
          values.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
        }
      }
  }

  public func elements(matching labels: [String], limit: Int = 5_000)
    -> [AccessibilityControlSnapshot]
  {
    descendants(of: application, limit: limit)
      .enumerated()
      .map { snapshot(of: $0.element, traversalIndex: $0.offset) }
      .filter { snapshot in
        let values = [snapshot.title, snapshot.description, snapshot.value].compactMap { $0 }
        return labels.contains { label in
          values.contains { $0.caseInsensitiveCompare(label) == .orderedSame }
        }
      }
  }

  public func composerSnapshot(
    limit: Int = 5_000
  ) -> AccessibilityComposerSnapshot {
    let elements = descendants(of: application, limit: limit)

    func composerSnapshot(
      of element: AXUIElement,
      traversalIndex: Int
    ) -> AccessibilityComposerElementSnapshot {
      AccessibilityComposerElementSnapshot(
        traversalIndex: traversalIndex,
        role: stringAttribute(kAXRoleAttribute, of: element),
        title: stringAttribute(kAXTitleAttribute, of: element),
        description: stringAttribute(kAXDescriptionAttribute, of: element),
        value: stringAttribute(kAXValueAttribute, of: element),
        frame: frame(of: element),
        actions: actionNames(of: element),
        enabled: booleanAttribute(kAXEnabledAttribute, of: element),
        focused: booleanAttribute(kAXFocusedAttribute, of: element),
        settableValue: isAttributeSettable(kAXValueAttribute, of: element)
      )
    }

    let indexed = elements.enumerated().map {
      (
        element: $0.element,
        snapshot: composerSnapshot(
          of: $0.element,
          traversalIndex: $0.offset
        )
      )
    }

    let inputs =
      indexed
      .filter {
        [$0.snapshot.role].compactMap { $0 }.contains {
          $0 == kAXTextAreaRole || $0 == kAXTextFieldRole
        }
      }
      .map(\.snapshot)

    let sendControls =
      indexed
      .filter {
        guard $0.snapshot.role == kAXButtonRole else { return false }
        let labels = [
          $0.snapshot.title,
          $0.snapshot.description,
          $0.snapshot.value,
        ].compactMap { $0 }
        return labels.contains {
          $0.localizedCaseInsensitiveContains("send")
        }
      }
      .map(\.snapshot)

    let inputFrames = inputs.compactMap(\.frame)
    let nearbyButtons =
      indexed
      .filter {
        guard $0.snapshot.role == kAXButtonRole,
          let buttonFrame = $0.snapshot.frame
        else {
          return false
        }

        let buttonCenter = CGPoint(
          x: buttonFrame.x + buttonFrame.width / 2,
          y: buttonFrame.y + buttonFrame.height / 2
        )

        return inputFrames.contains { inputFrame in
          let left = inputFrame.x - 100
          let right = inputFrame.x + inputFrame.width + 180
          let top = inputFrame.y - 120
          let bottom = inputFrame.y + inputFrame.height + 120
          return buttonCenter.x >= left
            && buttonCenter.x <= right
            && buttonCenter.y >= top
            && buttonCenter.y <= bottom
        }
      }
      .map(\.snapshot)

    return AccessibilityComposerSnapshot(
      inputs: inputs,
      sendControls: sendControls,
      nearbyButtons: nearbyButtons
    )
  }

  public func latestAssistantPayloadSelection(
    limit: Int = 5_000
  ) -> AccessibilityLatestPayloadSelection? {
    guard
      let selection = AccessibilityMessageStructure(
        application: application,
        limit: limit
      ).latestAssistantPayload()
    else {
      return nil
    }

    return AccessibilityLatestPayloadSelection(
      anchorLabel: selection.metadata.anchorLabel,
      anchorTraversalIndex: selection.metadata.anchorTraversalIndex,
      rootTraversalIndices: selection.metadata.rootTraversalIndices,
      rootCount: selection.roots.count
    )
  }

  public func latestAssistantSiblingSequence(
    limit: Int = 5_000
  ) -> [AccessibilityMessageSiblingSnapshot] {
    AccessibilityMessageStructure(application: application, limit: limit)
      .latestAssistantSiblingSequence()
      .map {
        AccessibilityMessageSiblingSnapshot(
          traversalIndex: $0.traversalIndex,
          role: $0.role,
          title: $0.title,
          description: $0.description,
          value: $0.value,
          containsRenderedText: $0.containsRenderedText
        )
      }
  }

  public func payloadCandidates(limit: Int = 5_000) -> [AccessibilityPayloadCandidate] {
    AccessibilityMessageStructure(application: application, limit: limit)
      .payloads()
      .map {
        AccessibilityPayloadCandidate(
          anchorLabel: $0.anchorLabel,
          anchorTraversalIndex: $0.anchorTraversalIndex,
          rootTraversalIndices: $0.rootTraversalIndices
        )
      }
  }

  public func latestPayloadTree(limit: Int = 5_000) -> [AccessibilityControlSnapshot] {
    let structure = AccessibilityMessageStructure(
      application: application,
      limit: limit
    )
    guard let payload = structure.latestAssistantPayload() else {
      return []
    }

    var result: [AccessibilityControlSnapshot] = []
    var traversalIndex = 0

    func append(_ element: AXUIElement) {
      result.append(
        snapshot(of: element, traversalIndex: traversalIndex)
      )
      traversalIndex += 1

      var children: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          element,
          kAXChildrenAttribute as CFString,
          &children
        ) == .success,
        let children = children as? [AXUIElement]
      else {
        return
      }

      for child in children {
        append(child)
      }
    }

    for root in payload.roots {
      append(root)
    }
    return result
  }

  private func descendants(of root: AXUIElement, limit: Int) -> [AXUIElement] {
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

  private func snapshot(of element: AXUIElement, traversalIndex: Int)
    -> AccessibilityControlSnapshot
  {
    AccessibilityControlSnapshot(
      traversalIndex: traversalIndex,
      role: stringAttribute(kAXRoleAttribute, of: element),
      title: stringAttribute(kAXTitleAttribute, of: element),
      description: stringAttribute(kAXDescriptionAttribute, of: element),
      value: stringAttribute(kAXValueAttribute, of: element),
      frame: frame(of: element),
      actions: actionNames(of: element)
    )
  }

  private func stringAttribute(_ attribute: String, of element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
      return nil
    }
    return value as? String
  }

  private func booleanAttribute(
    _ attribute: String,
    of element: AXUIElement
  ) -> Bool? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        element,
        attribute as CFString,
        &value
      ) == .success,
      let value
    else {
      return nil
    }
    return value as? Bool
  }

  private func isAttributeSettable(
    _ attribute: String,
    of element: AXUIElement
  ) -> Bool? {
    var settable = DarwinBoolean(false)
    guard
      AXUIElementIsAttributeSettable(
        element,
        attribute as CFString,
        &settable
      ) == .success
    else {
      return nil
    }
    return settable.boolValue
  }

  private func frame(of element: AXUIElement) -> AccessibilityFrame? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        == .success,
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
      let positionValue, let sizeValue
    else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
      AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else { return nil }
    return AccessibilityFrame(x: position.x, y: position.y, width: size.width, height: size.height)
  }

  private func actionNames(of element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
    return names as? [String] ?? []
  }
}
