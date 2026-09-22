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

struct AccessibilityMessageElementSnapshot {
  let traversalIndex: Int
  let role: String?
  let title: String?
  let description: String?
  let value: String?
  let parentTraversalIndex: Int?
  let childTraversalIndices: [Int]
  let containsRenderedText: Bool
}

public struct AccessibilityConversationElementSnapshot: Encodable {
  public let traversalIndex: Int
  public let role: String?
  public let title: String?
  public let description: String?
  public let value: String?
  public let parentTraversalIndex: Int?
  public let childTraversalIndices: [Int]
  public let containsRenderedText: Bool
}

public struct AccessibilityConversationSnapshot: Encodable {
  public let payloads: [AccessibilityPayloadCandidate]
  public let latestPayload: AccessibilityLatestPayloadSelection?
  public let latestAssistantSiblings: [AccessibilityMessageSiblingSnapshot]
  public let latestAssistantTree: [AccessibilityConversationElementSnapshot]
}

/// Read-only diagnostics for adapting ChatWorks to ChatGPT accessibility changes.
public struct ChatGPTAccessibilityInspector {
  private let application: AXUIElement

  init(application: AXUIElement) {
    self.application = application
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

  public func allElements(limit: Int = 5_000) -> [AccessibilityControlSnapshot] {
    descendants(of: application, limit: limit)
      .enumerated()
      .map { snapshot(of: $0.element, traversalIndex: $0.offset) }
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

  public func conversationSnapshot(
    limit: Int = 5_000
  ) -> AccessibilityConversationSnapshot {
    let structure = AccessibilityMessageStructure(
      application: application,
      limit: limit
    )
    let payloads = structure.payloads()

    let candidates = payloads.map {
      AccessibilityPayloadCandidate(
        anchorLabel: $0.anchorLabel,
        anchorTraversalIndex: $0.anchorTraversalIndex,
        rootTraversalIndices: $0.rootTraversalIndices
      )
    }

    let latest = structure.latestAssistantPayload(from: payloads)

    let latestSelection = latest.map {
      AccessibilityLatestPayloadSelection(
        anchorLabel: $0.metadata.anchorLabel,
        anchorTraversalIndex: $0.metadata.anchorTraversalIndex,
        rootTraversalIndices: $0.metadata.rootTraversalIndices,
        rootCount: $0.roots.count
      )
    }

    let siblings = structure.latestAssistantSiblingSequence().map {
      AccessibilityMessageSiblingSnapshot(
        traversalIndex: $0.traversalIndex,
        role: $0.role,
        title: $0.title,
        description: $0.description,
        value: $0.value,
        containsRenderedText: $0.containsRenderedText
      )
    }

    let tree =
      latest.map {
        structure.subtreeSnapshots(
          rootedAt: $0.metadata.rootTraversalIndices
        )
      } ?? []

    return AccessibilityConversationSnapshot(
      payloads: candidates,
      latestPayload: latestSelection,
      latestAssistantSiblings: siblings,
      latestAssistantTree: tree.map {
        AccessibilityConversationElementSnapshot(
          traversalIndex: $0.traversalIndex,
          role: $0.role,
          title: $0.title,
          description: $0.description,
          value: $0.value,
          parentTraversalIndex: $0.parentTraversalIndex,
          childTraversalIndices: $0.childTraversalIndices,
          containsRenderedText: $0.containsRenderedText
        )
      }
    )
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
