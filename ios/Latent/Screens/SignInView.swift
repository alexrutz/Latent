import SwiftUI

/// The address and the password, once.
///
/// Two fields and a button. The token this buys outlives the app, so for almost
/// every launch after the first this screen is never seen — which is the reason
/// to spend nothing on it beyond being clear about what went wrong.
struct SignInView: View {
    let session: Session

    @State private var address = Credentials.serverURL?.absoluteString ?? ""
    @State private var password = ""
    @FocusState private var focus: Field?

    private enum Field { case address, password }

    private var busy: Bool {
        if case .connecting = session.state { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://192.168.1.20:8080", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .address)
                        .submitLabel(.next)
                        .onSubmit { focus = .password }

                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .focused($focus, equals: .password)
                        .submitLabel(.go)
                        .onSubmit { go() }
                } header: {
                    Text("Your Latent server")
                } footer: {
                    Text("The address Latent is reachable at on your network, and the password you set when you first opened it.")
                }

                if let problem = session.problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }

                Section {
                    Button(action: go) {
                        HStack {
                            Spacer()
                            if busy { ProgressView().controlSize(.small) } else { Text("Sign in") }
                            Spacer()
                        }
                    }
                    .disabled(busy || address.isEmpty || password.isEmpty)
                }
            }
            .navigationTitle("Latent")
            .disabled(busy)
        }
    }

    private func go() {
        guard !address.isEmpty, !password.isEmpty else { return }
        focus = nil
        Task { await session.signIn(address: address, password: password) }
    }
}
