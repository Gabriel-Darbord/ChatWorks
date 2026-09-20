import Foundation

enum ComposerSemantics {
  static func isEmpty(
    value: String,
    descriptiveLabels: [String]
  ) -> Bool {
    let trimmedValue = value.trimmingCharacters(
      in: .whitespacesAndNewlines
    )

    if trimmedValue.isEmpty {
      return true
    }

    return descriptiveLabels.contains { label in
      let trimmedLabel = label.trimmingCharacters(
        in: .whitespacesAndNewlines
      )

      return !trimmedLabel.isEmpty
        && trimmedValue.caseInsensitiveCompare(trimmedLabel) == .orderedSame
    }
  }
}
