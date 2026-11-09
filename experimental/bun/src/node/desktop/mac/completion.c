// A ScreenCaptureKit completion block, for capture.ts: the one part of a capture bun:ffi can't make, since a block's
// function has to be native code. capture.rs's object_done and image_done in one: a slot that is itself a stack block
// (clang's Block ABI, no copy helpers, its one captured word the slot), whose function retains what it is given, the
// object or image and the NSError, and signals the slot's semaphore. ScreenCaptureKit's Block_copy copies the block's
// bytes, so the copy's word still names the slot. Compiled at run time by bun:ffi's `cc` (TinyCC), with no SDK: every
// declaration is spelled here, and CoreFoundation's CFRetain is looked up by the slot itself.
//
// A slot answers once. capture.ts frees it only once it has answered; one whose answer never came is left, a few
// bytes, against a crash if it came late.

typedef unsigned long size_t;

extern void *calloc(size_t count, size_t size);
extern void free(void *p);
extern void *dlopen(const char *path, int mode);
extern void *dlsym(void *lib, const char *name);
extern void *dispatch_semaphore_create(long value);
extern long dispatch_semaphore_wait(void *semaphore, unsigned long long timeout);
extern long dispatch_semaphore_signal(void *semaphore);
extern void dispatch_release(void *object);
extern void *_NSConcreteStackBlock[];

struct descriptor {
  size_t reserved;
  size_t size;
};

typedef struct slot slot;
struct slot {
  // The block literal: what Block_copy copies.
  void *isa;
  int flags;
  int reserved;
  void (*invoke)(slot *block, void *object, void *error);
  const struct descriptor *descriptor;
  slot *context;
  // The answer.
  void *semaphore;
  void *object;
  void *error;
};

static const struct descriptor block_descriptor = {0, 5 * sizeof(void *)};
static void *(*retain)(void *);

static void answered(slot *block, void *object, void *error) {
  slot *s = block->context;
  s->object = object ? retain(object) : 0;
  s->error = error ? retain(error) : 0;
  dispatch_semaphore_signal(s->semaphore);
}

/** A new slot to pass as a completion block, or 0 without CoreFoundation. */
slot *slot_new(void) {
  if (!retain) {
    void *cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", 1);
    retain = cf ? dlsym(cf, "CFRetain") : 0;
    if (!retain) return 0;
  }
  slot *s = calloc(1, sizeof(slot));
  if (!s) return 0;
  s->isa = _NSConcreteStackBlock;
  s->invoke = answered;
  s->descriptor = &block_descriptor;
  s->context = s;
  s->semaphore = dispatch_semaphore_create(0);
  return s;
}

/** 1 once the block has been called (true once only), else 0 at once. */
int slot_answered(slot *s) { return dispatch_semaphore_wait(s->semaphore, 0) == 0; }

/** What the block was given, retained (+1, the caller's to release), or 0. */
void *slot_object(slot *s) { return s->object; }
void *slot_error(slot *s) { return s->error; }

/** Frees an answered slot. */
void slot_free(slot *s) {
  dispatch_release(s->semaphore);
  free(s);
}
