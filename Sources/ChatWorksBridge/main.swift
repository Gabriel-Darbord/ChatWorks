import ChatWorksAX
import Foundation

struct UsageError: LocalizedError {
    var errorDescription: String? { "Usage: chatworks-ax read | chatworks-ax assistant-state | chatworks-ax scroll-to-bottom | chatworks-ax stage | chatworks-ax stage-and-send | chatworks-ax send | chatworks-ax list-chats | chatworks-ax select-chat <reference> | chatworks-ax new-chat | chatworks-ax inspect [label...] | chatworks-ax inspect-elements <label...>" }
}

@main
struct ChatWorksBridge {
    // Keep restoration available while interaction behavior is refined, but leave
    // ChatGPT active after bridge calls for now.
    private static let restoresFocus = false

    static func main() {
        do {
            let chat = try ChatGPTAccessibility.connect()
            defer {
                if restoresFocus { chat.restoreFocus() }
            }
            switch Array(CommandLine.arguments.dropFirst()) {
            case ["read"]:
                FileHandle.standardOutput.write(Data(try chat.latestAssistantRawText().utf8))
            case ["assistant-state"]:
                FileHandle.standardOutput.write(try JSONEncoder().encode(chat.assistantMessageState()))
            case ["scroll-to-bottom"]:
                chat.scrollToBottom()
            case ["stage"]:
                try chat.stage(String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self))
            case ["stage-and-send"]:
                try chat.stageAndSend(String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self))
            case ["send"]:
                try chat.send()
            case ["list-chats"]:
                let data = try JSONEncoder().encode(chat.chatReferences())
                FileHandle.standardOutput.write(data)
            case let arguments where arguments.count == 2 && arguments[0] == "select-chat":
                try chat.selectChat(arguments[1])
            case ["new-chat"]:
                try chat.newChat()
            case let arguments where arguments.first == "inspect":
                let data = try JSONEncoder().encode(chat.inspector().controls(matching: Array(arguments.dropFirst())))
                FileHandle.standardOutput.write(data)
            case let arguments where arguments.first == "inspect-elements":
                let data = try JSONEncoder().encode(chat.inspector().elements(matching: Array(arguments.dropFirst())))
                FileHandle.standardOutput.write(data)
            default:
                throw UsageError()
            }
        } catch AccessibilityError.copyControlNotFound {
            fputs("chatworks-ax: No assistant message is available to copy.\n", stderr)
            Foundation.exit(2)
        } catch {
            fputs("chatworks-ax: \(error.localizedDescription)\n", stderr)
            Foundation.exit(1)
        }
    }
}
