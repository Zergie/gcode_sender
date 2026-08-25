// Deliberately invalid: the portable integration harness must report this as
// a compiler failure, not as an unavailable prerequisite or skipped test.
void setup() {
  invalid_fixture_symbol();
}

void loop() {}
