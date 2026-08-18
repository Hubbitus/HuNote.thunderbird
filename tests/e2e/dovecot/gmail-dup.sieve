require ["copy", "fileinto", "imapsieve"];

# Gmail-mimicry: on APPEND to INBOX, place a physically distinct copy in
# [Gmail]/All Mail. This reproduces the Gmail behavior where the same
# Message-ID exists in INBOX AND in [Gmail]/All Mail as separate UIDs.
#
# :copy suppresses the default cancellation of the INBOX save — original
# message stays in INBOX; a MIME-identical duplicate lands in All Mail.

fileinto :copy "[Gmail]/All Mail";
