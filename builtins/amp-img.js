/**
 * Copyright 2015 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {BaseElement} from '../src/base-element';
import {isExperimentOn} from '../src/experiments';
import {isLayoutSizeDefined} from '../src/layout';
import {registerElement} from '../src/service/custom-element-registry';
import {srcsetFromElement, srcsetFromSrc} from '../src/srcset';

/**
 * Attributes to propagate to internal image when changed externally.
 * @type {!Array<string>}
 */
const ATTRIBUTES_TO_PROPAGATE = ['alt', 'title', 'referrerpolicy', 'aria-label',
  'aria-describedby', 'aria-labelledby'];

const EXPERIMENTAL_ATTRIBUTES_TO_PROPAGATE = ATTRIBUTES_TO_PROPAGATE
    .concat(['srcset', 'src', 'sizes', 'blur']);

const DELAY = 2000;

const TRANSITION_TIME = 1000;

export class AmpImg extends BaseElement {

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {boolean} */
    this.allowImgLoadFallback_ = true;

    /** @private {boolean} */
    this.isPrerenderAllowed_ = true;

    /** @private {?Element} */
    this.img_ = null;

    /** @private {?../src/srcset.Srcset} */
    this.srcset_ = null;

    /** @private @const {boolean} */
    this.useNativeSrcset_ = isExperimentOn(this.win, 'amp-img-native-srcset');

    this.blurSrc = null;
    this.useBlr = false;

    this.count = 0;

    this.src = null;
  }

  /** @override */
  mutatedAttributesCallback(mutations) {
    alert("swa");
    let mutated = false;
    if (!this.useNativeSrcset_) {
      if (mutations['srcset'] !== undefined) {
        // `srcset` mutations take precedence over `src` mutations.
        this.srcset_ = srcsetFromElement(this.element);
        mutated = true;
      } else if (mutations['src'] !== undefined) {
        // If only `src` is mutated, then ignore the existing `srcset` attribute
        // value (may be set automatically as cache optimization).
        this.srcset_ = srcsetFromSrc(this.element.getAttribute('src'));
        mutated = true;
      }
      // This element may not have been laid out yet.
      if (mutated && this.img_) {
        
        this.updateImageSrc_();
      }
    }

    if (this.img_) {
      const propAttrs = this.useNativeSrcset_ ?
        EXPERIMENTAL_ATTRIBUTES_TO_PROPAGATE :
        ATTRIBUTES_TO_PROPAGATE;
      const attrs = propAttrs.filter(
          value => mutations[value] !== undefined);
      this.propagateAttributes(
          attrs, this.img_, /* opt_removeMissingAttrs */ true);

      if (this.useNativeSrcset_) {
        this.guaranteeSrcForSrcsetUnsupportedBrowsers_();
      }

    }
  }

  /** @override */
  preconnectCallback(onLayout) {
    // NOTE(@wassgha): since parseSrcset is computationally expensive and can
    // not be inside the `buildCallback`, we went with preconnecting to the
    // `src` url if it exists or the first srcset url.
    const src = this.element.getAttribute('src');
    if (src) {
      this.preconnect.url(src, onLayout);
    } else {
      const srcset = this.element.getAttribute('srcset');
      if (!srcset) {
        return;
      }
      // We try to find the first url in the srcset
      const srcseturl = /https?:\/\/\S+/.exec(srcset);
      // Connect to the first url if it exists
      if (srcseturl) {
        this.preconnect.url(srcseturl[0], onLayout);
      }
    }
  }

  /** @override */
  buildCallback() {
    this.isPrerenderAllowed_ = !this.element.hasAttribute('noprerender');
  }

  /** @override */
  isLayoutSupported(layout) {
    return isLayoutSizeDefined(layout);
  }

  parseBitmap(str) {
    return str.trim().split(/\s+/g);
  }

  asRgbaBytes(hexArray) {
    return hexArray.map(this.toRgba)
        .reduce((a, b) => a.concat(b));
  }

  toDataURL(bytes, w, h) {
    let canvas = document.createElement('CANVAS');
    let ctx = canvas.getContext('2d');
    let imgData = ctx.createImageData(w, h);
  
    canvas.height = w;
    canvas.width = h;
  
    bytes.forEach((byte, i) => (imgData.data[i] = byte));
  
    ctx.putImageData(imgData, 0, 0);
  
    const dataUrl = canvas.toDataURL('png');
    
    canvas = null; // GC
    ctx = null; // GC
    imgData = null; // Gc
    
    return dataUrl;
  }


  toRgba(hex) {
    return [
      parseInt(hex.substr(0, 2), 16),
      parseInt(hex.substr(2, 2), 16),
      parseInt(hex.substr(4, 2), 16),
      255,   
    ];
  }
  /**
   * Create the actual image element and set up instance variables.
   * Called lazily in the first `#layoutCallback`.
   */
  initialize_() {
    if (this.img_) {
      return;
    }
    if (!this.useNativeSrcset_ && !this.srcset_) {
      this.srcset_ = srcsetFromElement(this.element);
    }
    this.src = this.element.getAttribute('src');
    // If this amp-img IS the fallback then don't allow it to have its own
    // fallback to stop from nested fallback abuse.
    this.allowImgLoadFallback_ = !this.element.hasAttribute('fallback');

    // For inabox SSR, image will have been written directly to DOM so no need
    // to recreate.  Calling appendChild again will have no effect.
    if (this.element.hasAttribute('i-amphtml-ssr')) {
      this.img_ = this.element.querySelector('img');
    }
    
    this.img_ = this.img_ || new Image();
    this.img_.setAttribute('decoding', 'async');
    if (this.element.id) {
      this.img_.setAttribute('amp-img-id', this.element.id);
    }

//////////////////////////////////////////////////////////////////////////////////
    if (this.element.hasAttribute('blur')) {
      this.useBlr = true;
      const hexString = this.element.getAttribute('blur');
      //alert(hexString);

      const img = new Image;
      const container = document.createElement('div');
      const w = parseInt(this.element.getAttribute("width"), 10);
      const h = parseInt(this.element.getAttribute("height"), 10);
      const dataUrl =
        this.toDataURL(
            this.asRgbaBytes(
                this.parseBitmap(
                    hexString)),
            5, 5);
      container.classList.add('blur-layer');

      img.src = dataUrl;
      img.width = w;
      img.height = h;
    
      this.blurSrc = dataUrl;
      container.appendChild(img);
    }






    ////////////////////////////////////////////////////////////////////////////////
    // Remove role=img otherwise this breaks screen-readers focus and
    // only read "Graphic" when using only 'alt'.
    if (this.element.getAttribute('role') == 'img') {
      this.element.removeAttribute('role');
      this.user().error(
          'AMP-IMG', 'Setting role=img on amp-img elements breaks ' +
        'screen readers please just set alt or ARIA attributes, they will ' +
        'be correctly propagated for the underlying <img> element.');
    }


    if (this.useNativeSrcset_) {
      this.propagateAttributes(EXPERIMENTAL_ATTRIBUTES_TO_PROPAGATE,
          this.img_);
      this.guaranteeSrcForSrcsetUnsupportedBrowsers_();
    } else {
      this.propagateAttributes(ATTRIBUTES_TO_PROPAGATE, this.img_);
    }

    this.applyFillContent(this.img_, true);

    this.element.appendChild(this.img_);
  }

  /** @override */
  prerenderAllowed() {
    return this.isPrerenderAllowed_;
  }

  /** @override */
  isRelayoutNeeded() {
    return true;
  }

  /** @override */
  reconstructWhenReparented() {
    return false;
  }

  /** @override */
  layoutCallback() {
    this.initialize_();
    //console.log("later skater");
    let promise = this.updateImageSrc_();

    // We only allow to fallback on error on the initial layoutCallback
    // or else this would be pretty expensive.
    if (this.allowImgLoadFallback_) {
      promise = promise.catch(e => {
        this.onImgLoadingError_();
        throw e;
      });
      this.allowImgLoadFallback_ = false;
    }
    return promise;
  }

  /**
   * Sets the img src to the first url in the srcset if srcset is defined but
   * src is not.
   * @private
   */
  guaranteeSrcForSrcsetUnsupportedBrowsers_() {
    if (!this.img_.hasAttribute('src') && 'srcset' in this.img_ == false) {
      const srcset = this.element.getAttribute('srcset');

      const srcseturl = /\S+/.match(srcset);
      if (srcseturl) {
        this.img_.setAttribute('src', srcseturl[0]);
      }
    }
  }


  blurAnim(t, v) {
    return new Promise(function(resolve) { 
        setTimeout(resolve.bind(null, v), t)
    });
 }

 loadImage() {
  return new Promise(resolve => setTimeout(() => { 
    this.img_.setAttribute('src', this.src);
    setTimeout(resolve, TRANSITION_TIME);
  }, DELAY));
    
}
  /**
   * @return {!Promise}
   * @private
   */
  updateImageSrc_(){
    if (this.getLayoutWidth() <= 0) {
      return Promise.resolve();
    }

    if (!this.useNativeSrcset_) {
      const src = this.srcset_.select(
          // The width should never be 0, but we fall back to the screen width
          // just in case.
          this.getViewport().getWidth() || this.win.screen.width,
          this.getDpr());
      if (src == this.img_.getAttribute('src') ) {
        return Promise.resolve();
      }

      
      
      if(this.blurSrc && this.useBlr){
        //alert("hi");
        this.img_.setAttribute('src', this.blurSrc);
        console.log("blur"+this.count +' ' +this.img_.getAttribute('src'))
        //this.useBlr = false;
      } else {
        this.img_.setAttribute('src', src);
        console.log("res"+this.count+ ' ' + this.img_.getAttribute('src'))
      }
      this.count++;
    }

    return this.loadPromise(this.img_).then(() => {
      // Clean up the fallback if the src has changed.
      if (!this.allowImgLoadFallback_ &&
          this.img_.classList.contains('i-amphtml-ghost')) {
        this.getVsync().mutate(() => {
          this.img_.classList.remove('i-amphtml-ghost');
          this.toggleFallback(false);
        });
      }
    })
    .then(() => {
      this.blurAnim(1000);
    })
    .then(() => {
      this.loadImage();
    });
  }

  onImgLoadingError_(){
    this.getVsync().mutate(() => {
      this.img_.classList.add('i-amphtml-ghost');
      this.toggleFallback(true);
      // Hide placeholders, as browsers that don't support webp
      // Would show the placeholder underneath a transparent fallback
      this.togglePlaceholder(false);
    });
  }
}

/**
 * @param {!Window} win Destination window for the new element.
 * @this {undefined}  // Make linter happy
 */
export function installImg(win) {
  registerElement(win, 'amp-img', AmpImg);
}