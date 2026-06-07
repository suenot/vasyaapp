#include "bindings/bindings.h"

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// Remove the WKWebView input accessory bar — the floating prev/next/done (↑ ↓ ✓) toolbar
// iOS shows above the keyboard. It is useless in this single-field chat UI and wastes space.
// The accessory comes from the private `WKContentView`, so we swizzle its `inputAccessoryView`
// getter to return nil. Done before `start_app()` creates the wry WKWebView.
static void disableWebViewInputAccessory(void) {
    Class cls = NSClassFromString(@"WKContentView");
    if (!cls) return;
    SEL sel = @selector(inputAccessoryView);
    Method m = class_getInstanceMethod(cls, sel);
    if (!m) return;
    IMP newImp = imp_implementationWithBlock(^id(id _self) { return nil; });
    method_setImplementation(m, newImp);
}

int main(int argc, char * argv[]) {
    (void)[WKWebView class]; // ensure WebKit is loaded so WKContentView is registered
    disableWebViewInputAccessory();
    ffi::start_app();
    return 0;
}
