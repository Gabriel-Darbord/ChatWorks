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

/// Read-only diagnostics for adapting ChatWorks to ChatGPT accessibility changes.
public struct ChatGPTAccessibilityInspector {
    private let application: AXUIElement

    init(application: AXUIElement) {
        self.application = application
    }

    public func controls(matching labels: [String] = [], limit: Int = 5_000) -> [AccessibilityControlSnapshot] {
        descendants(of: application, limit: limit)
            .enumerated()
            .map { snapshot(of: $0.element, traversalIndex: $0.offset) }
            .filter { snapshot in
                guard snapshot.actions.contains("AXPress") || snapshot.actions.contains("AXPick") else { return false }
                guard !labels.isEmpty else {
                    return snapshot.title != nil || snapshot.description != nil || snapshot.value != nil
                }
                let values = [snapshot.title, snapshot.description, snapshot.value].compactMap { $0 }
                return labels.contains { label in values.contains { $0.caseInsensitiveCompare(label) == .orderedSame } }
            }
    }

    public func elements(matching labels: [String], limit: Int = 5_000) -> [AccessibilityControlSnapshot] {
        descendants(of: application, limit: limit)
            .enumerated()
            .map { snapshot(of: $0.element, traversalIndex: $0.offset) }
            .filter { snapshot in
                let values = [snapshot.title, snapshot.description, snapshot.value].compactMap { $0 }
                return labels.contains { label in values.contains { $0.caseInsensitiveCompare(label) == .orderedSame } }
            }
    }

    private func descendants(of root: AXUIElement, limit: Int) -> [AXUIElement] {
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

    private func snapshot(of element: AXUIElement, traversalIndex: Int) -> AccessibilityControlSnapshot {
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
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func frame(of element: AXUIElement) -> AccessibilityFrame? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
              let positionValue, let sizeValue else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        return AccessibilityFrame(x: position.x, y: position.y, width: size.width, height: size.height)
    }

    private func actionNames(of element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
        return names as? [String] ?? []
    }
}
