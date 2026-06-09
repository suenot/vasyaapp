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

// The app is a fixed-layout chat UI: the document itself must never scroll or zoom.
// WKWebView's own UIScrollView still rubber-bands (drag the whole page down past the top)
// and bounces on zoom regardless of page CSS, so disable that at the native layer.
// wry creates the WKWebView internally — hook the designated initializer to reach it.
static void disableWebViewBounce(void) {
    Class cls = [WKWebView class];
    SEL sel = @selector(initWithFrame:configuration:);
    Method m = class_getInstanceMethod(cls, sel);
    if (!m) return;
    IMP origImp = method_getImplementation(m);
    IMP newImp = imp_implementationWithBlock(^id(id _self, CGRect frame, WKWebViewConfiguration *config) {
        WKWebView *wv = ((id (*)(id, SEL, CGRect, id))origImp)(_self, sel, frame, config);
        if (wv) {
            wv.scrollView.bounces = NO;
            wv.scrollView.alwaysBounceVertical = NO;
            wv.scrollView.alwaysBounceHorizontal = NO;
            wv.scrollView.bouncesZoom = NO;
        }
        return wv;
    });
    method_setImplementation(m, newImp);
}

int main(int argc, char * argv[]) {
    (void)[WKWebView class]; // ensure WebKit is loaded so WKContentView is registered
    disableWebViewInputAccessory();
    disableWebViewBounce();
    ffi::start_app();
    return 0;
}
