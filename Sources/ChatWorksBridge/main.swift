import ChatWorksAX
import Foundation

struct UsageError: LocalizedError {
  var errorDescription: String? {
    "Usage: chatworks-ax read | chatworks-ax message-parts | chatworks-ax assistant-observation | chatworks-ax assistant-state | chatworks-ax composer-state | chatworks-ax scroll-to-bottom | chatworks-ax stage | chatworks-ax stage-and-send | chatworks-ax guarded-stage-and-send | chatworks-ax send | chatworks-ax list-chats | chatworks-ax select-chat <reference> | chatworks-ax new-chat | chatworks-ax rename-chat <reference> <new-title> | chatworks-ax inspect [label...] | chatworks-ax inspect-composer | chatworks-ax inspect-elements <label...> | chatworks-ax inspect-latest-siblings | chatworks-ax inspect-payload-candidates | chatworks-ax inspect-latest-payload-tree | chatworks-ax inspect-latest-payload"
  }
}

@main
struct ChatWorksBridge {
  // Keep restoration available while interaction behavior is refined, but leave
  // ChatGPT active after bridge calls for now.
  private static let restoresFocus = false

  static func main() {
    do {
      let arguments = Array(CommandLine.arguments.dropFirst())
      let activatingCommands: Set<String> = [
        "stage",
        "stage-and-send",
        "guarded-stage-and-send",
        "send",
        "select-chat",
        "new-chat",
        "rename-chat",
      ]
      let activatesChatGPT =
        arguments.first.map { activatingCommands.contains($0) } ?? false

      let chat = try ChatGPTAccessibility.connect(activate: activatesChatGPT)
      defer {
        if restoresFocus { chat.restoreFocus() }
      }

      switch arguments {
      case ["read"]:
        FileHandle.standardOutput.write(Data(try chat.latestAssistantRawText().utf8))
      case ["message-parts"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.latestAssistantParts())
        )
      case ["assistant-observation"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.latestAssistantObservation())
        )
      case ["assistant-state"]:
        FileHandle.standardOutput.write(try JSONEncoder().encode(chat.assistantMessageState()))
      case ["composer-state"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.composerState())
        )
      case ["scroll-to-bottom"]:
        chat.scrollToBottom()
      case ["stage"]:
        try chat.stage(
          String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self))
      case ["stage-and-send"]:
        try chat.stageAndSend(
          String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self))
      case ["guarded-stage-and-send"]:
        let text = String(
          decoding: FileHandle.standardInput.readDataToEndOfFile(),
          as: UTF8.self
        )
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.guardedStageAndSend(text))
        )
      case ["send"]:
        try chat.send()
      case ["list-chats"]:
        let data = try JSONEncoder().encode(chat.chatReferences())
        FileHandle.standardOutput.write(data)
      case let arguments where arguments.count == 2 && arguments[0] == "select-chat":
        try chat.selectChat(arguments[1])
      case let arguments where arguments.count == 3 && arguments[0] == "rename-chat":
        try chat.renameChat(
          arguments[1],
          newTitle: arguments[2]
        )
      case ["new-chat"]:
        try chat.newChat()

      case ["inspect-composer"]:
        FileHandle.standardOutput.write(
          try JSONEncoder().encode(chat.inspector().composerSnapshot())
        )
      case let arguments where arguments.first == "inspect":
        let data = try JSONEncoder().encode(
          chat.inspector().controls(matching: Array(arguments.dropFirst())))
        FileHandle.standardOutput.write(data)
      case let arguments where arguments.first == "inspect-elements":
        let data = try JSONEncoder().encode(
          chat.inspector().elements(matching: Array(arguments.dropFirst())))
        FileHandle.standardOutput.write(data)
      case ["inspect-latest-siblings"]:
        let data = try JSONEncoder().encode(
          chat.inspector().latestAssistantSiblingSequence()
        )
        FileHandle.standardOutput.write(data)
      case ["inspect-payload-candidates"]:
        let data = try JSONEncoder().encode(chat.inspector().payloadCandidates())
        FileHandle.standardOutput.write(data)
      case ["inspect-latest-payload-tree"]:
        let data = try JSONEncoder().encode(chat.inspector().latestPayloadTree())
        FileHandle.standardOutput.write(data)
      case ["inspect-latest-payload"]:
        let data = try JSONEncoder().encode(chat.inspector().latestAssistantPayloadSelection())
        FileHandle.standardOutput.write(data)
      default:
        throw UsageError()
      }
    } catch AccessibilityError.copyControlNotFound {
      fputs("chatworks-ax: No assistant message is available to copy.\n", stderr)
      Foundation.exit(2)
    } catch AccessibilityError.assistantMessageNotFound {
      fputs("chatworks-ax: No assistant message is available.\n", stderr)
      Foundation.exit(2)
    } catch {
      fputs("chatworks-ax: \(error.localizedDescription)\n", stderr)
      Foundation.exit(1)
    }
  }
}
