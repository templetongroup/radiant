# Rules

Short on purpose. Every line is something that already cost Tony time.

## Diagnosis

1. **Measure the running system before naming a cause.** Response headers, the
   listening port, what is on disk in `/Applications`, which processes exist.
   Code tells you what should happen; his symptom is what does. When they
   disagree, the code reading is the thing that is wrong.
2. **A theory is a theory until something measured confirms it.** Say which it
   is. On 2026-08-26 four confident diagnoses of one sync bug were wrong; the
   fifth came from one `curl` that could have been run first.
3. **If it cannot be measured from here, ask for the one command that measures
   it.** One command beats a fifth guess.

## Verification

4. **Test the path the user takes, not the mechanism underneath.** Click the
   button. Open the pane. Pick the theme from the picker. Passing an API test
   for a feature reached by a button proves nothing about the button.
5. **Verify in `/Applications`, not the dev server.** Different PATH, different
   startup, different first-run.
6. **`npm run release` runs the gates. Do not bypass them.** Contrast, API,
   smoke. It now builds first — a gate that passes against yesterday's binary
   is worse than no gate.
6b. **Bump the version before releasing.** The script reads it; it does not
    raise it. Same version means no user is ever offered the update.
7. **Verify the exact surface that was reported.** If the sidebar was wrong,
   check the sidebar.

## Shipping

8. **Batch changes; one release per verified batch.** Roughly twenty-five
   releases in a day, many fixing the previous one, is the failure mode.
9. **Never hand the user a terminal command as the fix.** Rescuing his machine
   right now is fine — say that is what it is. The product still has to repair
   itself.
10. **Install by copy-verify-swap, never delete-then-copy**, and never copy from
    a directory a build is writing to.
11. **A public download must be fetched, not assumed.** HEAD returns 404 on
    GitHub's asset CDN even when the file is fine; use GET.

## Product

12. **Never render a state the user cannot act on.** No sentence without a
    button. No "quit and reopen" that changes nothing.
13. **Never claim a setting's state from a proxy.** Ask the documented API.
14. **A setting nobody can set is not a setting.** If code reads it, something
    must write it.
15. **Anything two Macs both edit needs its own file.** iCloud Drive has no
    merge; the later write wins and the other Mac's work is gone.
16. **Nothing temporary belongs in a file that syncs.**
17. **The phone is the other half of the app.** A convention that ships on the
    Mac is not shipped until iPhone has it. `/plain-english` worked on one and
    was silently absent on the other.
18. **A skill is read, never run.** Nothing installable may contain an
    executable file, and the refusal names the file.
