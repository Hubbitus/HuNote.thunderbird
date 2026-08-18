require ["copy", "fileinto", "imapsieve", "environment", "variables"];

# Gmail-mimicry: on APPEND to ANY user folder, place a physically distinct copy in
# [Gmail]/All Mail. This reproduces Gmail label semantics where a message in a label
# folder also exists in [Gmail]/All Mail as a separate UID.
#
# Skip when the APPEND target IS [Gmail]/All Mail — would recurse.
# imapsieve exposes target mailbox via environment "imap.mailbox".
#
# :copy suppresses the default cancellation of the target-mailbox save.

if not environment :is "imap.mailbox" "[Gmail]/All Mail" {
    fileinto :copy "[Gmail]/All Mail";
}
